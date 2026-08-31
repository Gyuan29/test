#!/usr/bin/env npx tsx
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { briefingRuns, events, organizations } from "../../db/schema";
import { chatCompletion } from "../../lib/llm-client";
import { sendWebhook, type WebhookProvider } from "../../lib/notifier";

const DB_PATH = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(process.cwd(), ".local/d1.sqlite");
const enabled = /^(true|1|yes)$/i.test(process.env.ENABLE_DAILY_BRIEFING?.trim() || "false");
const integerEnv = (name: string, fallback: number, minimum: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
};
const LOOKBACK_HOURS = integerEnv("DAILY_BRIEFING_LOOKBACK_HOURS", 24, 1);
const MIN_SCORE = Math.min(10, integerEnv("DAILY_BRIEFING_MIN_SCORE", 6, 0));
const MAX_EVENTS = integerEnv("DAILY_BRIEFING_MAX_EVENTS", 60, 1);

type EventInput = {
  id: string;
  organization: string;
  title: string;
  summary: string;
  eventDate: string;
  eventType: string;
  relevanceScore: number;
  sourceUrl: string;
  sourceName: string;
  createdAt: string;
};

type Development = {
  title: string;
  organization: string;
  summary: string;
  significance: string;
  url: string;
};

type BriefingPayload = {
  headline: string;
  keyDevelopments: Development[];
  crossInstitutionTrends: string[];
  implications: string[];
  watchlist: string[];
};

function isoForSql(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(text).filter(Boolean);
}

function parsePayload(response: string, fallbackEvents: EventInput[]): BriefingPayload | null {
  const body = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] || response;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body.slice(start, end + 1)) as unknown; } catch {
    try {
      const repaired = body.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1").replace(/[“”]/g, '"');
      parsed = JSON.parse(repaired) as unknown;
    } catch { return null; }
  }
  const value = record(parsed);
  if (!value) return null;
  const developments: Development[] = Array.isArray(value.keyDevelopments) ? value.keyDevelopments.flatMap((item): Development[] => {
    const current = record(item);
    if (!current) return [];
    return [{
      title: text(current.title),
      organization: text(current.organization),
      summary: text(current.summary),
      significance: text(current.significance),
      url: text(current.url),
    }];
  }).filter((item) => item.title || item.summary) : [];
  if (!developments.length && !fallbackEvents.length) return null;
  return {
    headline: text(value.headline) || "过去 24 小时机构情报简报",
    keyDevelopments: developments,
    crossInstitutionTrends: stringArray(value.crossInstitutionTrends),
    implications: stringArray(value.implications),
    watchlist: stringArray(value.watchlist),
  };
}

function fallbackPayload(input: EventInput[]): BriefingPayload {
  return {
    headline: "过去 24 小时机构情报简报",
    keyDevelopments: input.map((item) => ({ title: item.title, organization: item.organization, summary: item.summary || item.title, significance: `相关性评分 ${item.relevanceScore}/10`, url: item.sourceUrl })),
    crossInstitutionTrends: [],
    implications: [],
    watchlist: [],
  };
}

function markdown(payload: BriefingPayload, windowStart: Date, windowEnd: Date): string {
  const lines = [`# ${payload.headline}`, `时间窗口：${windowStart.toISOString()} 至 ${windowEnd.toISOString()}`, ""];
  lines.push("## 重点动态", "");
  if (payload.keyDevelopments.length) {
    payload.keyDevelopments.forEach((item, index) => {
      const source = /^https?:\/\//i.test(item.url) ? ` [原文](${item.url})` : "";
      lines.push(`${index + 1}. **${item.organization || "未标注机构"}**：${item.title || item.summary}${source}`);
      if (item.summary && item.summary !== item.title) lines.push(`   - 摘要：${item.summary}`);
      if (item.significance) lines.push(`   - 判断：${item.significance}`);
    });
  } else lines.push("暂无符合条件的重点动态");
  const sections: Array<[string, string[]]> = [["跨机构趋势", payload.crossInstitutionTrends], ["影响判断", payload.implications], ["后续关注", payload.watchlist]];
  sections.forEach(([heading, values]) => { lines.push("", `## ${heading}`, ""); if (values.length) values.forEach((value) => lines.push(`- ${value}`)); else lines.push("暂无"); });
  return lines.join("\n");
}

function plainTextFallback(input: EventInput[], windowStart: Date, windowEnd: Date): string {
  const lines = [`过去 ${LOOKBACK_HOURS} 小时机构情报简报`, `时间窗口：${windowStart.toISOString()} 至 ${windowEnd.toISOString()}`, "", "重点动态："];
  input.forEach((item, index) => lines.push(`${index + 1}. ${item.organization}：${item.title}。${item.summary || ""}${item.sourceUrl ? ` 原文：${item.sourceUrl}` : ""}`));
  return lines.join("\n");
}

function providerFromEnv(): WebhookProvider {
  const value = process.env.WEBHOOK_PROVIDER?.trim().toLowerCase();
  return value === "feishu" || value === "dingtalk" || value === "wework" || value === "generic" ? value : "generic";
}

function webhookUrl(provider: WebhookProvider): string {
  return process.env.WEBHOOK_URL?.trim() || (provider === "feishu" ? process.env.FEISHU_WEBHOOK_URL?.trim() : provider === "dingtalk" ? process.env.DINGTALK_WEBHOOK_URL?.trim() : provider === "wework" ? process.env.WEWORK_WEBHOOK_URL?.trim() : "") || "";
}

async function ensureBriefingTable(client: ReturnType<typeof createClient>): Promise<void> {
  await client.executeMultiple(`CREATE TABLE IF NOT EXISTS briefing_runs (id TEXT PRIMARY KEY, window_start TEXT NOT NULL, window_end TEXT NOT NULL, event_count INTEGER NOT NULL DEFAULT 0, content_hash TEXT NOT NULL, status TEXT NOT NULL, generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, pushed_at TEXT, error TEXT, UNIQUE(window_start, window_end, content_hash)); CREATE INDEX IF NOT EXISTS briefing_runs_window_idx ON briefing_runs(window_start, window_end);`);
}

async function main(): Promise<void> {
  if (!enabled) { console.log("[daily-briefing] disabled (set ENABLE_DAILY_BRIEFING=true to enable)"); return; }
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - LOOKBACK_HOURS * 3_600_000);
  const windowStartIso = windowStart.toISOString();
  const windowEndIso = windowEnd.toISOString();
  const client = createClient({ url: DB_PATH === ":memory:" ? "file::memory:" : `file:${DB_PATH}` });
  const db = drizzle(client);
  try {
    await ensureBriefingTable(client);
    const rows = await db.select({ id: events.id, organization: organizations.name, title: events.title, summary: events.summary, eventDate: events.eventDate, eventType: events.eventType, relevanceScore: events.relevanceScore, sourceUrl: events.sourceUrl, sourceName: events.sourceName, createdAt: events.createdAt }).from(events).innerJoin(organizations, eq(events.organizationId, organizations.entityId)).where(and(gte(events.createdAt, isoForSql(windowStart)), lt(events.createdAt, isoForSql(windowEnd)), gte(events.relevanceScore, MIN_SCORE))).orderBy(desc(events.relevanceScore), desc(events.createdAt)).limit(MAX_EVENTS).all();
    const input: EventInput[] = rows.map((row) => ({ id: row.id, organization: row.organization, title: text(row.title), summary: text(row.summary), eventDate: text(row.eventDate), eventType: text(row.eventType), relevanceScore: Number(row.relevanceScore || 0), sourceUrl: text(row.sourceUrl), sourceName: text(row.sourceName), createdAt: text(row.createdAt) }));
    const contentHash = createHash("sha256").update(`${windowStartIso}|${windowEndIso}|${input.map((item) => item.id).join(",")}`).digest("hex");
    const existing = await db.select({ id: briefingRuns.id, status: briefingRuns.status }).from(briefingRuns).where(and(eq(briefingRuns.windowStart, windowStartIso), eq(briefingRuns.windowEnd, windowEndIso), eq(briefingRuns.contentHash, contentHash))).limit(1).get();
    if (existing && ["running", "generated", "pushed"].includes(existing.status)) { console.log(`[daily-briefing] already processed: ${existing.id} (${existing.status})`); return; }
    const runId = existing?.id || randomUUID();
    if (existing) await db.update(briefingRuns).set({ status: "running", error: null, eventCount: input.length, generatedAt: new Date().toISOString() }).where(eq(briefingRuns.id, runId)).run();
    else await db.insert(briefingRuns).values({ id: runId, windowStart: windowStartIso, windowEnd: windowEndIso, eventCount: input.length, contentHash, status: "running" }).run();
    if (!input.length) {
      await db.update(briefingRuns).set({ status: "generated", generatedAt: new Date().toISOString() }).where(eq(briefingRuns.id, runId)).run();
      console.log("[daily-briefing] no qualifying events");
      return;
    }
    const response = await chatCompletion("你是机构情报分析师。只返回 JSON，不要 Markdown 或解释。字段必须为 headline、keyDevelopments、crossInstitutionTrends、implications、watchlist。keyDevelopments 是对象数组，每项包含 title、organization、summary、significance、url；其余字段是字符串数组。只使用输入事实，不得补造事件。", JSON.stringify({ windowStart: windowStartIso, windowEnd: windowEndIso, events: input }), { max_tokens: integerEnv("DAILY_BRIEFING_MAX_OUTPUT_TOKENS", 3000, 256) });
    const parsedPayload = parsePayload(response, input);
    const payload = parsedPayload || fallbackPayload(input);
    const content = parsedPayload ? markdown(payload, windowStart, windowEnd) : plainTextFallback(input, windowStart, windowEnd);
    const provider = providerFromEnv();
    const url = webhookUrl(provider);
    if (!url) {
      await db.update(briefingRuns).set({ status: "failed", error: "WEBHOOK_URL is not configured", generatedAt: new Date().toISOString() }).where(eq(briefingRuns.id, runId)).run();
      throw new Error("WEBHOOK_URL is not configured");
    }
    const result = await sendWebhook({ provider, url, title: payload.headline, markdown: content, retries: Number(process.env.WEBHOOK_RETRY_COUNT) || 2, timeoutMs: Number(process.env.WEBHOOK_TIMEOUT_MS) || 15_000, maxBytes: Number(process.env.WEBHOOK_MAX_BYTES) || 18_000 });
    if (!result.ok) {
      await db.update(briefingRuns).set({ status: "failed", error: result.error || `HTTP ${result.status}`, generatedAt: new Date().toISOString() }).where(eq(briefingRuns.id, runId)).run();
      throw new Error(result.error || `Webhook failed with HTTP ${result.status}`);
    }
    await db.update(briefingRuns).set({ status: "pushed", pushedAt: new Date().toISOString(), generatedAt: new Date().toISOString(), error: null }).where(eq(briefingRuns.id, runId)).run();
    console.log(`[daily-briefing] pushed ${input.length} events via ${provider}`);
  } finally { client.close(); }
}

main().catch((error) => { console.error(`[daily-briefing] failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
