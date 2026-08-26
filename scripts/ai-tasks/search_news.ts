#!/usr/bin/env npx tsx
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { events, organizations } from "../../db/schema";
import { chatCompletion } from "../../lib/llm-client";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DB_PATH = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(ROOT, ".local/d1.sqlite");
const PROGRESS = resolve(ROOT, "data/event_search_progress.json");
const SEARXNG = (process.env.SEARXNG_URL?.trim() || "http://localhost:8080").replace(/\/+$/, "");
const MAX_RESULTS = 20;
const MIN_SCORE = 6;
type Status = "pending" | "success" | "failed";
type EventType = "report" | "partnership" | "personnel" | "policy" | "research" | "award" | "other";
type Organization = { entityId: string; name: string; officialDomain: string | null; sources: string | null; lastEventSearchedAt: string | null; eventSearchStatus: Status };
type Candidate = { title: string; url: string; summary: string; eventDate: string; sourceName: string; relevanceScore?: number; eventType?: EventType };
type Args = { skipHours: number; force: boolean; limit: number | undefined; taskId: string };
type Progress = { taskId: string; total: number; processed: number; success: number; failed: number; currentInstitution: string | null; status: "running" | "completed" | "failed"; message?: string; lastUpdated: string };

const text = (value: unknown): string => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
const canonical = (value: string): string | null => { try { const url = new URL(value.trim()); if (!["http:", "https:"].includes(url.protocol)) return null; url.hash = ""; return url.toString(); } catch { return null; } };
const officialUrl = (value: string | null): string | null => value ? canonical(/^https?:\/\//i.test(value) ? value : `https://${value}`) : null;
const hostname = (value: string): string => { try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return "unknown"; } };
const eventDate = (value: string, url: string): string => { const match = `${value} ${url}`.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/); if (!match) return "unknown"; const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))); return Number.isNaN(parsed.getTime()) ? "unknown" : parsed.toISOString().slice(0, 10); };

function parseArgs(): Args {
  let skipHours = 24; let force = false; let limit: number | undefined; let taskId = `event_search_${Date.now()}`;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) { const arg = args[i]; if (arg === "--force") force = true; else if (arg === "--skip-hours" || arg === "--limit" || arg === "--task-id") { const raw = args[++i]; if (!raw) throw new Error(`${arg} requires a value`); if (arg === "--task-id") taskId = raw; else { const value = Number(raw); const minimum = arg === "--skip-hours" ? 0 : 1; if (!Number.isInteger(value) || value < minimum) throw new Error(`${arg} must be a valid integer`); if (arg === "--skip-hours") skipHours = value; else limit = value; } } else if (arg === "--help" || arg === "-h") { console.log("Usage: search_news.ts [--skip-hours N] [--force] [--limit N] [--task-id ID]"); process.exit(0); } else if (arg !== "--resume") throw new Error(`Unknown argument: ${arg}`); }
  return { skipHours, force, limit, taskId };
}
function saveProgress(progress: Progress): void {
  mkdirSync(dirname(PROGRESS), { recursive: true });
  writeFileSync(PROGRESS, `${JSON.stringify({ ...progress, lastUpdated: new Date().toISOString() }, null, 2)}\n`, "utf8");
}
function candidate(title: string, url: string, summary: string, published = ""): Candidate { return { title: text(title) || url, url, summary: text(summary), eventDate: eventDate(published, url), sourceName: hostname(url) }; }

async function searx(query: string): Promise<Candidate[]> { const url = new URL(`${SEARXNG}/search`); url.searchParams.set("q", query); url.searchParams.set("categories", "news,general"); url.searchParams.set("time_range", "year"); url.searchParams.set("format", "json"); const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) }); if (!response.ok) throw new Error(`SearXNG HTTP ${response.status}`); const payload = await response.json() as { results?: unknown[] }; return (payload.results || []).flatMap((item): Candidate[] => { if (!item || typeof item !== "object") return []; const raw = item as Record<string, unknown>; const resultUrl = typeof raw.url === "string" ? canonical(raw.url) : null; if (!resultUrl) return []; return [candidate(text(raw.title), resultUrl, text(raw.content), text(raw.publishedDate ?? raw.published_date))]; }).slice(0, MAX_RESULTS); }
/*
async function pageLinks(url: string): Promise<Candidate[]> { const response = await fetch(url, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(10_000) }); if (!response.ok) return []; const html = await response.text(); const output: Candidate[] = []; for (const match of html.matchAll(/href=["']([^"']+)["'][^>]*>([^<]*)</gi)) { if (output.length >= MAX_RESULTS) break; const title = text(match[2]); if (!/(news|event|announcement|press|新闻|动态|公告)/i.test(`${title} ${match[1]}`)) continue; const link = canonical(new URL(match[1], url).toString()); if (link) output.push(candidate(title, link, title)); } return output; }
async function sourceLinks(organization: Organization): Promise<Candidate[]> { let parsed: unknown; try { parsed = organization.sources ? JSON.parse(organization.sources) : []; } catch { return []; } if (!Array.isArray(parsed)) return []; const output: Candidate[] = []; for (const item of parsed.slice(0, 20)) { const value = typeof item === "string" ? item : item && typeof item === "object" && "url" in item && typeof item.url === "string" ? item.url : ""; const url = canonical(value); if (!url) continue; try { output.push(...await pageLinks(url)); } catch (error) { console.error(`[新闻:${organization.name}] 候选来源失败`, error); } } return output; }
function queries(organization: Organization): string[] { const quoted = `"${organization.name}"`; const domain = officialUrl(organization.officialDomain); return domain ? [`${quoted} site:${hostname(domain)}`, `${quoted} 新闻`, `${quoted} 最新动态`, `${quoted} news`] : [`${quoted} 新闻`, `${quoted} 最新动态`, `${quoted} news`, `${quoted} latest`]; }
*/
async function pageLinks(url: string): Promise<Candidate[]> {
  const response = await fetch(url, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return [];
  const html = await response.text();
  const output: Candidate[] = [];
  for (const match of html.matchAll(/href=["']([^"']+)["'][^>]*>([^<]*)</gi)) {
    if (output.length >= MAX_RESULTS) break;
    const title = text(match[2]);
    if (!/(news|event|announcement|press)/i.test(`${title} ${match[1]}`)) continue;
    const link = canonical(new URL(match[1], url).toString());
    if (link) output.push(candidate(title, link, title));
  }
  return output;
}

async function sourceLinks(organization: Organization): Promise<Candidate[]> {
  let parsed: unknown;
  try { parsed = organization.sources ? JSON.parse(organization.sources) : []; } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const output: Candidate[] = [];
  for (const item of parsed.slice(0, 20)) {
    const value = typeof item === "string" ? item : item && typeof item === "object" && "url" in item && typeof item.url === "string" ? item.url : "";
    const url = canonical(value);
    if (!url) continue;
    try { output.push(...await pageLinks(url)); } catch (error) { console.error(`[news:${organization.name}] source failed`, error); }
  }
  return output;
}

function queries(organization: Organization): string[] {
  const quoted = `"${organization.name}"`;
  const domain = officialUrl(organization.officialDomain);
  return domain
    ? [`${quoted} site:${hostname(domain)}`, `${quoted} news`, `${quoted} latest`, `${quoted} announcement`]
    : [`${quoted} news`, `${quoted} latest`, `${quoted} announcement`];
}

function parseArray(value: string): unknown[] { const body = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] || value; const start = body.indexOf("["); const end = body.lastIndexOf("]"); if (start < 0 || end <= start) return []; try { const parsed = JSON.parse(body.slice(start, end + 1)); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
async function extractEvents(organization: Organization, candidates: Candidate[]): Promise<Candidate[]> { if (!candidates.length) return []; const response = await chatCompletion("Extract only directly relevant organization news events as a JSON array. Each item must include url,title,summary,event_date,event_type,relevance_score (1-10).", JSON.stringify({ organization: organization.name, candidates })); const byUrl = new Map(candidates.map((item) => [item.url, item])); const types: EventType[] = ["report", "partnership", "personnel", "policy", "research", "award", "other"]; return parseArray(response).flatMap((item): Candidate[] => { if (!item || typeof item !== "object") return []; const raw = item as Record<string, unknown>; const url = typeof raw.url === "string" ? canonical(raw.url) : null; const score = Number(raw.relevance_score); const original = url ? byUrl.get(url) : undefined; if (!url || !original || !Number.isInteger(score) || score < MIN_SCORE || score > 10) return []; return [{ ...original, url, title: text(raw.title) || original.title, summary: text(raw.summary) || original.summary, eventDate: text(raw.event_date) || original.eventDate, eventType: types.includes(raw.event_type as EventType) ? raw.event_type as EventType : "other", relevanceScore: score }]; }); }
function dedupe(results: Candidate[]): Candidate[] { const output: Candidate[] = []; const seen = new Set<string>(); for (const item of results.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))) { const key = item.title.toLocaleLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, ""); if (seen.has(item.url) || output.some((x) => key && (x.title.toLocaleLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, "").includes(key) || key.includes(x.title.toLocaleLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, ""))))) continue; seen.add(item.url); output.push(item); } return output.slice(0, 10); }
async function discover(organization: Organization): Promise<Candidate[]> { const hasWebsite = Boolean(officialUrl(organization.officialDomain)); console.log(`[搜索] 机构 ${organization.name} (${hasWebsite ? "有官网" : "无官网"})：使用${hasWebsite ? "官网优先" : "降级名称搜索"}策略`); const collected: Candidate[] = []; for (const query of queries(organization)) { try { collected.push(...await searx(query)); } catch (error) { console.error(`[新闻:${organization.name}] 搜索失败`, error); } } if (hasWebsite) { const url = officialUrl(organization.officialDomain); if (url) { try { collected.push(...await pageLinks(url)); } catch (error) { console.error(`[新闻:${organization.name}] 官网抓取失败`, error); } } } collected.push(...await sourceLinks(organization)); const unique = [...new Map(collected.map((item) => [item.url, item])).values()].slice(0, MAX_RESULTS); return dedupe(await extractEvents(organization, unique)); }

async function main(): Promise<void> { const args = parseArgs(); if (DB_PATH !== ":memory:") mkdirSync(dirname(DB_PATH), { recursive: true }); const client = createClient({ url: DB_PATH === ":memory:" ? "file::memory:" : `file:${DB_PATH}` }); const db = drizzle(client); try { const all = await db.select({ entityId: organizations.entityId, name: organizations.name, officialDomain: organizations.websiteUrl, sources: organizations.sources, lastEventSearchedAt: organizations.lastEventSearchedAt, eventSearchStatus: organizations.eventSearchStatus }).from(organizations).all() as Organization[]; const cutoff = Date.now() - args.skipHours * 60 * 60 * 1000; const eligible = args.force ? all : all.filter((item) => { if (item.eventSearchStatus === "pending" || !item.lastEventSearchedAt) return true; const timestamp = Date.parse(item.lastEventSearchedAt); return Number.isNaN(timestamp) || timestamp < cutoff; }); const pending = eligible.slice(0, args.limit); let success = 0; let failed = 0; let processed = 0; saveProgress({ taskId: args.taskId, total: pending.length, processed: 0, success: 0, failed: 0, currentInstitution: null, status: "running", lastUpdated: new Date().toISOString() }); console.log(`[调度] 机构总数 ${all.length}，符合条件 ${eligible.length}，本次处理 ${pending.length}`); const existing = new Set((await db.select({ sourceUrl: events.sourceUrl }).from(events).all()).map((item) => item.sourceUrl ? canonical(item.sourceUrl) : null).filter((item): item is string => Boolean(item))); for (const organization of pending) { saveProgress({ taskId: args.taskId, total: pending.length, processed, success, failed, currentInstitution: organization.name, status: "running", lastUpdated: new Date().toISOString() }); let status: Status = "success"; try { for (const result of await discover(organization)) { if (existing.has(result.url)) continue; await db.insert(events).values({ id: randomUUID(), organizationId: organization.entityId, eventDate: result.eventDate, eventType: result.eventType || "other", relevanceScore: result.relevanceScore, title: result.title, summary: result.summary || result.title, sourceUrl: result.url, sourceName: result.sourceName }).run(); existing.add(result.url); } success += 1; } catch (error) { status = "failed"; failed += 1; console.error(`[新闻:${organization.name}] 处理失败`, error); } const now = new Date().toISOString(); await db.update(organizations).set({ lastEventSearchedAt: now, eventSearchStatus: status, updatedAt: now }).where(eq(organizations.entityId, organization.entityId)).run(); processed += 1; saveProgress({ taskId: args.taskId, total: pending.length, processed, success, failed, currentInstitution: organization.name, status: processed === pending.length ? "completed" : "running", lastUpdated: now }); } if (!pending.length) saveProgress({ taskId: args.taskId, total: 0, processed: 0, success: 0, failed: 0, currentInstitution: null, status: "completed", lastUpdated: new Date().toISOString() }); } finally { client.close(); } }
function taskIdFromArgv(): string {
  const index = process.argv.indexOf("--task-id");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("-") ? value : `event_search_${Date.now()}`;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const taskId = taskIdFromArgv();
  console.error(`[事件搜索:${taskId}] 任务失败`, error);
  try {
    const current = existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS, "utf8")) as Partial<Progress> : {};
    const sameTask = current.taskId === taskId;
    saveProgress({
      taskId,
      total: sameTask && Number.isInteger(current.total) ? current.total as number : 0,
      processed: sameTask && Number.isInteger(current.processed) ? current.processed as number : 0,
      success: sameTask && Number.isInteger(current.success) ? current.success as number : 0,
      failed: sameTask && Number.isInteger(current.failed) ? current.failed as number : 0,
      currentInstitution: sameTask && typeof current.currentInstitution === "string" ? current.currentInstitution : null,
      status: "failed",
      message,
      lastUpdated: new Date().toISOString(),
    });
  } catch (progressError) {
    console.error(`[事件搜索:${taskId}] 无法写入失败进度`, progressError);
  }
  process.exitCode = 1;
});
