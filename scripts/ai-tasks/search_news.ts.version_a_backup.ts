#!/usr/bin/env npx tsx
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "cheerio";
import { eq } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { events, organizations } from "../../db/schema";
import { chatCompletion } from "../../lib/llm-client";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DB_PATH = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(ROOT, ".local", "d1.sqlite");
const PROGRESS_PATH = resolve(ROOT, "data", "event_search_progress.json");
const SEARXNG_URL = (process.env.SEARXNG_URL?.trim() || "http://localhost:8080").replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 20;
const MAX_PER_DOMAIN = 2;
const MIN_RELEVANCE_SCORE = 6;
const LLM_SYSTEM_PROMPT = "你是严格的机构情报事件审核员。只提取与目标机构有直接、实质性关联的真实事件，例如发布报告、重要人事变动、战略合作、政策发布、科研成果、重大项目或获奖。\n必须忽略：仅在正文中顺带提及机构名称的无关新闻、招聘广告、商业广告、网页导航或聚合列表文本，以及同一事件的重复报道；重复报道只保留信息量最丰富、来源最权威的一条。\n只返回 JSON 数组，不要 Markdown 或解释。每项必须包含 title、summary、url、event_date（YYYY-MM-DD 或 unknown）、event_type（report、partnership、personnel、policy、research、award、other 之一）、relevance_score（1-10 的整数）。relevance_score 低于 6 的项目应直接排除。";

type Status = "pending" | "success" | "failed";
type Organization = { entityId: string; name: string; officialDomain: string | null; sources: string | null; lastEventSearchedAt: string | null; eventSearchStatus: Status };
type EventType = "report" | "partnership" | "personnel" | "policy" | "research" | "award" | "other";
type Result = { title: string; url: string; summary: string; eventDate: string; sourceName: string; relevanceScore: number; eventType: EventType };
type Args = { skipHours: number; force: boolean; limit?: number; taskId: string };
type Progress = { taskId: string; total: number; processed: number; success: number; failed: number; currentInstitution: string | null; status: "running" | "completed" | "failed"; lastUpdated: string };

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let skipHours = 24; let force = false; let limit: number | undefined; let taskId = `event_search_${Date.now()}`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") force = true;
    else if (arg === "--skip-hours" || arg === "--limit" || arg === "--task-id") {
      const raw = args[++index];
      if (!raw) throw new Error(`${arg} requires a value`);
      if (arg === "--task-id") taskId = raw;
      else { const value = Number(raw); if (!Number.isInteger(value) || value < (arg === "--skip-hours" ? 0 : 1)) throw new Error(`${arg} must be a valid integer`); if (arg === "--skip-hours") skipHours = value; else limit = value; }
    } else if (arg === "--help" || arg === "-h") { console.log("Usage: search_news.ts [--skip-hours N] [--force] [--limit N] [--task-id ID]"); process.exit(0); }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { skipHours, force, limit, taskId };
}

function saveProgress(progress: Progress): void {
  progress.lastUpdated = new Date().toISOString();
  mkdirSync(dirname(PROGRESS_PATH), { recursive: true });
  // The admin API polls this file on Windows. Direct overwrite avoids EPERM
  // failures when a concurrent reader has the file open during rename.
  writeFileSync(PROGRESS_PATH, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
}

function text(value: unknown): string { return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""; }
function normalize(value: string): string { return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, ""); }
function canonicalUrl(value: string): string | null { try { const url = new URL(value.trim()); if (!["http:", "https:"].includes(url.protocol)) return null; url.hash = ""; return url.toString(); } catch { return null; } }
function hostname(url: string): string { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return "unknown"; } }
function officialUrl(value: string | null): string | null { return value ? canonicalUrl(/^https?:\/\//i.test(value) ? value : `https://${value}`) : null; }
function abbreviation(name: string): string { return name.match(/[A-Za-z]+/g)?.map((part) => part[0]).join("").toLowerCase() || [...name.replace(/[^\u4e00-\u9fff]/g, "")].slice(0, 4).join(""); }
function keywords(name: string): string[] { const normalized = normalize(name); const core = normalized.replace(/(大学|学院|研究院|研究所|中心|实验室|集团|公司|委员会|科学院)$/u, ""); return [...new Set([core, normalized.slice(0, 3), normalized.slice(0, 2)].filter((value) => value.length >= 2))]; }
function relevant(title: string, summary: string, name: string): boolean { const haystack = normalize(`${title} ${summary}`); return keywords(name).some((keyword) => haystack.includes(keyword)); }
function eventDate(value: string, url: string): string { const match = `${value} ${url}`.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/); if (!match) return "unknown"; const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))); return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString().slice(0, 10); }
function candidateResult(title: string, url: string, summary: string, date: string): Result { return { title, url, summary, eventDate: date, sourceName: hostname(url), relevanceScore: 0, eventType: "other" }; }

function strategies(organization: Organization): string[] {
  const quoted = `"${organization.name}"`; const queries = [`${quoted} news`, `${quoted} 新闻`, `${quoted} 最新动态`, `${quoted} latest`, `${quoted} site:edu.cn`, `${quoted} site:ac.cn`, quoted];
  const domain = officialUrl(organization.officialDomain); if (domain) queries.push(`site:${hostname(domain)} news`);
  const short = abbreviation(organization.name); if (short) queries.push(`${short} news`);
  return [...new Set(queries)];
}

async function search(query: string, organization: Organization): Promise<Result[]> {
  const url = new URL(`${SEARXNG_URL}/search`); url.searchParams.set("q", query); url.searchParams.set("categories", "news,general"); url.searchParams.set("time_range", "year"); url.searchParams.set("format", "json");
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`SearXNG HTTP ${response.status}`);
  const payload = await response.json() as { results?: unknown };
  if (!Array.isArray(payload.results)) return [];
  return payload.results.flatMap((item): Result[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>; const resultUrl = typeof raw.url === "string" ? canonicalUrl(raw.url) : null; if (!resultUrl) return [];
    const summary = text(raw.content); const title = text(raw.title) || summary.slice(0, 160) || resultUrl; if (!relevant(title, `${summary} ${resultUrl}`, organization.name)) return [];
    return [candidateResult(title, resultUrl, summary, eventDate(text(raw.publishedDate ?? raw.published_date), resultUrl))];
  }).slice(0, MAX_RESULTS);
}

async function homepage(organization: Organization): Promise<Result[]> {
  const url = officialUrl(organization.officialDomain); if (!url) return [];
  const response = await fetch(url, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }); if (!response.ok) return [];
  const page = load(await response.text()); const results: Result[] = [];
  page("a[href]").each((_index, element) => { if (results.length >= MAX_RESULTS) return; const title = text(page(element).text()); const href = page(element).attr("href"); if (!href || !/news|event|announcement|新闻|公告/i.test(`${title} ${href}`)) return; const resultUrl = canonicalUrl(new URL(href, url).toString()); if (!resultUrl || !relevant(title, resultUrl, organization.name)) return; results.push(candidateResult(title || resultUrl, resultUrl, title, eventDate(title, resultUrl))); });
  return results;
}

async function sourcePages(organization: Organization): Promise<Result[]> {
  let parsed: unknown;
  try { parsed = organization.sources ? JSON.parse(organization.sources) : []; } catch { parsed = []; }
  if (!Array.isArray(parsed)) return [];
  const results: Result[] = [];
  for (const item of parsed.slice(0, 20)) {
    const sourceUrl = typeof item === "string" ? item : item && typeof item === "object" && "url" in item && typeof item.url === "string" ? item.url : "";
    const url = canonicalUrl(sourceUrl); if (!url) continue;
    try {
      const response = await fetch(url, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }); if (!response.ok) continue;
      const page = load(await response.text());
      page("a[href]").each((_index, element) => { if (results.length >= MAX_RESULTS) return; const title = text(page(element).text()); const href = page(element).attr("href"); if (!href || !/news|event|announcement|新闻|公告/i.test(`${title} ${href}`)) return; const resultUrl = canonicalUrl(new URL(href, url).toString()); if (!resultUrl || !relevant(title, resultUrl, organization.name)) return; results.push(candidateResult(title || resultUrl, resultUrl, title, eventDate(title, resultUrl))); });
    } catch (error) { console.error(`[news:${organization.name}] source fallback failed`, error); }
  }
  return results;
}

function parseJsonArray(value: string): unknown[] {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] || value;
  const start = fenced.indexOf("["); const end = fenced.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("LLM response did not contain a JSON array");
  const parsed: unknown = JSON.parse(fenced.slice(start, end + 1));
  return Array.isArray(parsed) ? parsed : [];
}

async function extractEvents(organization: Organization, candidates: Result[]): Promise<Result[]> {
  if (!candidates.length) return [];
  console.log(`[LLM] 正在提取新闻标题和摘要（${organization.name}，候选 ${candidates.length} 条）...`);
  const response = await chatCompletion(
    LLM_SYSTEM_PROMPT,
    JSON.stringify({ organization: organization.name, candidates: candidates.map(({ title, url, summary, eventDate, sourceName }) => ({ title, url, summary, event_date: eventDate, source: sourceName })) }),
  );
  const byUrl = new Map(candidates.map((candidate) => [candidate.url, candidate]));
  const eventTypes = new Set<EventType>(["report", "partnership", "personnel", "policy", "research", "award", "other"]);
  return parseJsonArray(response).flatMap((item): Result[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    const url = typeof raw.url === "string" ? canonicalUrl(raw.url) : null;
    if (!url) return [];
    const candidate = byUrl.get(url);
    const score = Number(raw.relevance_score);
    if (!candidate || !Number.isInteger(score) || score < MIN_RELEVANCE_SCORE || score > 10) return [];
    const title = text(raw.title) || candidate.title;
    const summary = text(raw.summary) || candidate.summary;
    const type = typeof raw.event_type === "string" && eventTypes.has(raw.event_type as EventType) ? raw.event_type as EventType : "other";
    const parsedDate = text(raw.event_date);
    return [{ ...candidate, title, summary, eventDate: parsedDate === "unknown" ? candidate.eventDate : eventDate(parsedDate, url), relevanceScore: score, eventType: type }];
  });
}

function titleSimilarity(left: string, right: string): number {
  const a = normalize(left); const b = normalize(right);
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return 1;
  const aChars = new Set([...a]); const bChars = new Set([...b]);
  const intersection = [...aChars].filter((char) => bChars.has(char)).length;
  return intersection / new Set([...aChars, ...bChars]).size;
}

function filterQualityAndDuplicates(results: Result[]): Result[] {
  const accepted: Result[] = [];
  for (const result of [...results].filter((item) => item.relevanceScore >= MIN_RELEVANCE_SCORE).sort((a, b) => b.relevanceScore - a.relevanceScore)) {
    if (accepted.some((existing) => titleSimilarity(existing.title, result.title) >= 0.65)) continue;
    accepted.push(result);
  }
  return accepted.slice(0, MAX_RESULTS);
}

async function discover(organization: Organization): Promise<Result[]> {
  const collected: Result[] = [];
  for (const query of strategies(organization)) {
    console.log(`[搜索] ${organization.name}: ${query}`);
    try {
      const found = await search(query, organization);
      collected.push(...found);
      if (collected.length >= 3) break;
    } catch (error) {
      console.error(`[news:${organization.name}] ${query}:`, error instanceof Error ? error.message : error);
    }
  }
  if (collected.length < 3) collected.push(...await homepage(organization));
  if (collected.length < MAX_RESULTS && (!organization.officialDomain || organization.eventSearchStatus === "failed")) collected.push(...await sourcePages(organization));
  const seen = new Set<string>(); const domains = new Map<string, number>();
  const candidates = collected.filter((result) => { if (seen.has(result.url)) return false; const count = domains.get(result.sourceName) || 0; if (count >= MAX_PER_DOMAIN) return false; seen.add(result.url); domains.set(result.sourceName, count + 1); return true; }).slice(0, MAX_RESULTS);
  const extracted = await extractEvents(organization, candidates);
  const filtered = filterQualityAndDuplicates(extracted);
  console.log(`[清洗] ${organization.name}: 候选 ${candidates.length}，LLM 保留 ${extracted.length}，去重后 ${filtered.length}`);
  return filtered;
}

async function main(): Promise<void> {
  const args = parseArgs(); if (DB_PATH !== ":memory:") mkdirSyncSync(dirname(DB_PATH));
  const client = createClient({ url: DB_PATH === ":memory:" ? "file::memory:" : `file:${DB_PATH}` }); const db = drizzle(client);
  try {
    await client.execute("ALTER TABLE organizations ADD COLUMN last_event_searched_at TEXT").catch(() => undefined); await client.execute("ALTER TABLE organizations ADD COLUMN event_search_status TEXT NOT NULL DEFAULT 'pending'").catch(() => undefined); await client.execute("ALTER TABLE events ADD COLUMN relevance_score INTEGER").catch(() => undefined);
    const all = await db.select({ entityId: organizations.entityId, name: organizations.name, officialDomain: organizations.websiteUrl, sources: organizations.sources, lastEventSearchedAt: organizations.lastEventSearchedAt, eventSearchStatus: organizations.eventSearchStatus }).from(organizations).all() as Organization[];
    const cutoff = Date.now() - args.skipHours * 60 * 60 * 1000; const eligible = args.force ? all : all.filter((item) => item.eventSearchStatus === "pending" || !item.lastEventSearchedAt || Date.parse(item.lastEventSearchedAt) < cutoff); const pending = eligible.slice(0, args.limit); console.log(`[调度] 机构总数 ${all.length}，符合条件 ${eligible.length}，本次处理 ${pending.length}（limit=${args.limit ?? "全量"}，force=${args.force}）`); let success = 0; let failed = 0; let processed = 0;
    saveProgress({ taskId: args.taskId, total: pending.length, processed: 0, success: 0, failed: 0, currentInstitution: null, status: "running", lastUpdated: new Date().toISOString() });
    const existing = new Set((await db.select({ sourceUrl: events.sourceUrl }).from(events).all()).map((item) => item.sourceUrl ? canonicalUrl(item.sourceUrl) : null).filter((item): item is string => Boolean(item)));
    for (const organization of pending) {
      console.log(`[搜索] 正在为机构 ${organization.name} 搜索新闻...`);
      let status: Status = "success";
      try { const results = await discover(organization); let saved = 0; for (const result of results) { if (existing.has(result.url)) continue; await db.insert(events).values({ id: randomUUID(), organizationId: organization.entityId, eventDate: result.eventDate, eventType: result.eventType, relevanceScore: result.relevanceScore, title: result.title, summary: result.summary || result.title, sourceUrl: result.url, sourceName: result.sourceName }).run(); existing.add(result.url); saved += 1; } console.log(`[数据库] 已保存 ${saved} 条事件（${organization.name}）`); success += 1; }
      catch (error) { status = "failed"; failed += 1; console.error(`[news:${organization.name}] failed`, error); }
      const now = new Date().toISOString(); await db.update(organizations).set({ lastEventSearchedAt: now, eventSearchStatus: status, updatedAt: now }).where(eq(organizations.entityId, organization.entityId)).run(); processed += 1; saveProgress({ taskId: args.taskId, total: pending.length, processed, success, failed, currentInstitution: organization.name, status: processed === pending.length ? "completed" : "running", lastUpdated: now }); console.log(`[进度] ${processed}/${pending.length}，成功 ${success}，失败 ${failed}`);
    }
    if (pending.length === 0) saveProgress({ taskId: args.taskId, total: 0, processed: 0, success: 0, failed: 0, currentInstitution: null, status: "completed", lastUpdated: new Date().toISOString() });
  } finally { client.close(); }
}

function mkdirSyncSync(path: string): void { mkdirSync(path, { recursive: true }); }
main().catch((error) => { console.error("Event search failed:", error); process.exitCode = 1; });
