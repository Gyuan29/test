#!/usr/bin/env npx tsx
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { events, organizations } from "../../db/schema";
import { CONFIG } from "../../lib/config";
import { chatCompletion as rawChatCompletion } from "../../lib/llm-client";
import { cancelResponseBody, createLimiter, fetchControlled, formatRequestError, logActiveSockets } from "../../lib/http-control";
import { extractNews } from "../../lib/news-extractor";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DB_PATH = CONFIG.LOCAL_SQLITE_PATH || resolve(ROOT, ".local/d1.sqlite");
const PROGRESS_DIR = resolve(ROOT, "data");
const SEARXNG = CONFIG.SEARXNG_URL.replace(/\/+$/, "");
const MAX_RESULTS = CONFIG.NEWS_MAX_RESULTS;
const MIN_SCORE = CONFIG.MIN_RELEVANCE_SCORE;
const GARBAGE_TEXT = /(登录|注冊|注册|广告|cookie|404)/iu;
const SNIPPET_GARBAGE_TEXT = /(登录|注冊|注册|广告|cookie|404|隐私政策|加载中|首页)/iu;
const REQUEST_TIMEOUT_MS = CONFIG.NEWS_REQUEST_TIMEOUT_MS;
const LLM_TIMEOUT_MS = CONFIG.LLM_TIMEOUT_MS;
const DEFAULT_LOOKBACK_DAYS = CONFIG.EVENT_LOOKBACK_DAYS;
const searxLimiter = createLimiter(CONFIG.SEARXNG_CONCURRENCY);
const homepageLimiter = createLimiter(CONFIG.HOMEPAGE_CONCURRENCY);
const llmLimiter = createLimiter(CONFIG.LLM_CONCURRENCY);
const extractorLimiter = createLimiter(CONFIG.NEWS_EXTRACTOR_CONCURRENCY);
const EXTRACTOR_ENABLED = CONFIG.ENABLE_NEWS_EXTRACTOR;
const EXTRACTOR_MAX_CHARS = CONFIG.EXTRACTOR_MAX_CHARS;
const EXTRACTOR_MIN_BODY_CHARS = CONFIG.EXTRACTOR_MIN_BODY_CHARS;
let monitoredOrganizations = 0;
const DEBUG_LLM_FULL_OUTPUT = CONFIG.DEBUG_LLM_FULL_OUTPUT;
let lastLlmTrace: { systemPrompt: string; userPrompt: string; rawOutput: string } | null = null;
const STRICT_JSON_INSTRUCTION = "You are a strict data extraction API. You MUST output ONLY a valid JSON array. Do NOT output any conversational text, explanations, or markdown outside the JSON array. IMPORTANT: You MUST output ONLY valid JSON. Do NOT include any explanatory text, markdown formatting (unless inside the JSON block), or conversational filler.";
const CONTENT_SOURCE_INSTRUCTION = "For content marked as [FULL TEXT], extract events comprehensively. For content marked as [SNIPPET MODE - LIMITED INFO], information is very limited; use only the supplied summary. If no valid event can be confirmed from a snippet, ignore it. These markers are input-only labels; never include them in the final output. Return only a valid JSON array.";
const chatCompletion = (prompt: string, input: string): Promise<string> => { monitoredOrganizations += 1; if (monitoredOrganizations % 10 === 0) logActiveSockets(`search-news ${monitoredOrganizations}`); const systemPrompt = `${STRICT_JSON_INSTRUCTION}\n\n${prompt}\n\n${CONTENT_SOURCE_INSTRUCTION}\n\n${STRICT_JSON_INSTRUCTION}`; return llmLimiter.run(async () => { try { const rawOutput = await rawChatCompletion(systemPrompt, input, { timeout: LLM_TIMEOUT_MS, jsonMode: true }); lastLlmTrace = { systemPrompt, userPrompt: input, rawOutput }; return rawOutput; } catch (error) { lastLlmTrace = { systemPrompt, userPrompt: input, rawOutput: "" }; throw error; } }); };
type Status = "pending" | "success" | "failed";
type EventType = "report" | "partnership" | "personnel" | "policy" | "research" | "award" | "other";
type Organization = { entityId: string; slug: string; name: string; officialDomain: string | null; sources: string | null; lastEventSearchedAt: string | null; eventSearchStatus: Status };
type Candidate = { title: string; url: string; summary: string; eventDate: string; sourceName: string; relevanceScore?: number; eventType?: EventType; llmContext?: string; extractionMethod: "full-text" | "snippet-fallback" };
type ExtractorStats = { processed: number; platformRule: number; genericRule: number; fallback: number; errors: number };
type DiscoverResult = { raw: number; llm: number; results: Candidate[]; extractor: ExtractorStats };
type Args = { skipHours: number; force: boolean; resume: boolean; limit?: number; taskId: string; days: number };
type FailureStatus = "llm_parse_failed" | "failed";
type ManifestFailureReason = "network_timeout" | "network_error" | "llm_parse_failed" | "no_valid_source" | "processing_failed";
type Progress = { taskId: string; total: number; processed: number; success: number; failed: number; currentInstitution: string | null; status: "running" | "completed" | "failed"; message?: string; errorMessage?: string; lastFailureStatus?: FailureStatus; lastUpdated: string };
type LlmEventRecord = {
  title: string;
  summary: string;
  url: string;
  relevanceScore?: number;
  relevance_score?: number;
  eventDate?: string;
  event_date?: string;
  eventType?: string;
  event_type?: string;
};
type ParsedLlmEvents = { ok: true; items: LlmEventRecord[] } | { ok: false; reason: string; rawPreview: string };
class LlmParseError extends Error {
  readonly code = "llm_parse_failed" as const;
  constructor(readonly reason: string, readonly rawPreview: string) {
    super(`llm_parse_failed: ${reason}`);
    this.name = "LlmParseError";
  }
}
const text = (value: unknown): string => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
function safeTaskId(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96) || "default"; }
function progressPathForTask(taskId: string): string { return resolve(PROGRESS_DIR, `event_search_progress_${safeTaskId(taskId)}.json`); }
function manifestPathForTask(taskId: string): string { return resolve(PROGRESS_DIR, `event_search_manifest_${safeTaskId(taskId)}.json`); }
function writeManifest(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
  try { writeFileSync(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 }); try { renameSync(temporary, path); } catch { writeFileSync(path, body, { encoding: "utf8", mode: 0o600 }); unlinkSync(temporary); } }
  catch (error) { try { unlinkSync(temporary); } catch { /* Preserve the original write failure. */ } throw error; }
}
function manifestFailureReason(error: unknown, discovered?: DiscoverResult): ManifestFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return "network_timeout";
  if (/network|ECONN|fetch failed|HTTP 5\d\d/i.test(message)) return "network_error";
  if (error instanceof LlmParseError || /llm_parse_failed|JSON parsing|schema validation/i.test(message)) return "llm_parse_failed";
  if (discovered && discovered.raw === 0) return "no_valid_source";
  return "processing_failed";
}
function readProgress(progressPath: string, taskId: string): Progress | null {
  if (!existsSync(progressPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(progressPath, "utf8")) as Partial<Progress>;
    if (parsed.taskId !== taskId) return null;
    return parsed as Progress;
  } catch (error) {
    console.warn(`[进度:${taskId}] 无法读取历史进度: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
const canonical = (value: string): string | null => { try { const url = new URL(value.trim()); if (!["http:", "https:"].includes(url.protocol)) return null; url.hash = ""; return url.toString(); } catch { return null; } };
const officialUrl = (value: string | null): string | null => value ? canonical(/^https?:\/\//i.test(value) ? value : `https://${value}`) : null;
const hostname = (value: string): string => { try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ""); } catch { return "unknown"; } };
const eventDate = (value: string, url: string): string => { const match = `${value} ${url}`.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/); if (!match) return "unknown"; const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))); return Number.isNaN(parsed.getTime()) ? "unknown" : parsed.toISOString().slice(0, 10); };
function parseArgs(): Args {
  console.log("[DEBUG] process.argv:", process.argv);
  let skipHours = 24; let force = false; let resume = false; let limit: number | undefined; let taskId = `event_search_${Date.now()}`; let days = DEFAULT_LOOKBACK_DAYS;
  const args = process.argv.slice(2); const valueOptions = new Set(["--skip-hours", "--limit", "--task-id", "--days"]);
  let i = 0;
  while (i < args.length) {
    const token = args[i]; const equals = token.indexOf("="); const arg = equals >= 0 ? token.slice(0, equals) : token; let raw = equals >= 0 ? token.slice(equals + 1) : undefined;
    if (arg === "--force" && equals < 0) { force = true; i += 1; continue; }
    if (arg === "--resume" && equals < 0) { resume = true; i += 1; continue; }
    if (arg === "--help" || arg === "-h") { console.log("Usage: search_news.ts [--skip-hours N] [--days N] [--force] [--resume] [--limit N] [--task-id ID]"); process.exit(0); }
    if (!valueOptions.has(arg)) throw new Error(`Unknown argument: ${token}. Supported options: --skip-hours N, --days N, --limit N, --task-id ID, --force`);
    if (raw === undefined) { i += 1; raw = args[i]; }
    if (!raw || raw.startsWith("--")) throw new Error(`${arg} requires a value. Use ${arg}=VALUE or ${arg} VALUE.`);
    if (arg === "--task-id") taskId = raw;
    else { const value = Number(raw); const minimum = arg === "--skip-hours" ? 0 : 1; if (!Number.isInteger(value) || value < minimum) throw new Error(`${arg} must be a valid integer`); if (arg === "--skip-hours") skipHours = value; else if (arg === "--days") days = value; else limit = value; }
    i += 1;
  }
  return { skipHours, force, resume, limit, taskId, days };
}
function saveProgress(progress: Progress, progressPath: string): void {
  mkdirSync(dirname(progressPath), { recursive: true });
  const body = `${JSON.stringify({ ...progress, lastUpdated: new Date().toISOString() }, null, 2)}\n`;
  const temporaryPath = `${progressPath}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, body, { encoding: "utf8", flag: "wx" });
    try {
      renameSync(temporaryPath, progressPath);
    } catch (error) {
      console.error(`[进度:${progress.taskId}] 原子替换失败，尝试兼容性写入: ${error instanceof Error ? error.message : String(error)}`);
      writeFileSync(progressPath, body, "utf8");
      try { unlinkSync(temporaryPath); } catch { /* The fallback may have already moved or removed it. */ }
    }
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* Preserve the original write error. */ }
    throw error;
  }
}
function candidate(title: string, url: string, summary: string, published = ""): Candidate { return { title: text(title) || url, url, summary: text(summary), eventDate: eventDate(published, url), sourceName: hostname(url), extractionMethod: "snippet-fallback" }; }
function timeRange(days: number): "day" | "week" | "month" | "year" { if (days <= 1) return "day"; if (days <= 7) return "week"; if (days <= 31) return "month"; return "year"; }
async function searx(query: string, days: number): Promise<Candidate[]> { return searxLimiter.run(async () => { const url = new URL(`${SEARXNG}/search`); url.searchParams.set("q", query); url.searchParams.set("categories", "news,general"); url.searchParams.set("time_range", timeRange(days)); url.searchParams.set("format", "json"); let response: Response | undefined; try { response = await fetchControlled(url, { headers: { accept: "application/json" } }, REQUEST_TIMEOUT_MS); if (!response.ok) throw new Error(`SearXNG HTTP ${response.status}`); const payload = await response.json() as { results?: unknown[] }; return (payload.results || []).flatMap((item): Candidate[] => { if (!item || typeof item !== "object") return []; const raw = item as Record<string, unknown>; const resultUrl = typeof raw.url === "string" ? canonical(raw.url) : null; return resultUrl ? [candidate(text(raw.title), resultUrl, text(raw.content), text(raw.publishedDate ?? raw.published_date))] : []; }).slice(0, MAX_RESULTS); } catch (error) { throw new Error(`SearXNG request failed (${formatRequestError(error)})`, { cause: error }); } finally { if (response) await cancelResponseBody(response); } }); }
async function pageLinks(url: string): Promise<Candidate[]> { return homepageLimiter.run(async () => { let response: Response | undefined; try { response = await fetchControlled(url, { headers: { accept: "text/html" } }, REQUEST_TIMEOUT_MS); if (!response.ok) return []; const html = await response.text(); const output: Candidate[] = []; for (const match of html.matchAll(/href=["']([^"']+)["'][^>]*>([^<]*)</gi)) { if (output.length >= MAX_RESULTS) break; const title = text(match[2]); if (!/(news|event|announcement|press)/i.test(`${title} ${match[1]}`)) continue; const link = canonical(new URL(match[1], url).toString()); if (link) output.push(candidate(title, link, title)); } return output; } catch (error) { throw new Error(`Official website request failed for ${url} (${formatRequestError(error)})`, { cause: error }); } finally { if (response) await cancelResponseBody(response); } }); }
async function sourceLinks(organization: Organization): Promise<Candidate[]> { let parsed: unknown; try { parsed = organization.sources ? JSON.parse(organization.sources) : []; } catch { return []; } if (!Array.isArray(parsed)) return []; const output: Candidate[] = []; for (const item of parsed.slice(0, CONFIG.MAX_SOURCE_LINKS)) { const value = typeof item === "string" ? item : item && typeof item === "object" && "url" in item && typeof item.url === "string" ? item.url : ""; const url = canonical(value); if (!url) continue; try { output.push(...await pageLinks(url)); } catch (error) { console.error(`[news:${organization.name}] source failed`, error); } } return output; }
function queries(organization: Organization): string[] { const quoted = `"${organization.name}"`; const domain = officialUrl(organization.officialDomain); return domain ? [`${quoted} site:${hostname(domain)}`, `${quoted} news`, `${quoted} latest`, `${quoted} announcement`] : [`${quoted} news`, `${quoted} latest`, `${quoted} announcement`]; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function jsonArrayCandidates(value: string): string[] {
  const candidates: string[] = [];
  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== "[") continue;
    let depth = 0; let inString = false; let escaped = false;
    for (let index = start; index < value.length; index += 1) {
      const character = value[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") inString = false;
        continue;
      }
      if (character === "\"") { inString = true; continue; }
      if (character === "[") depth += 1;
      else if (character === "]") {
        depth -= 1;
        if (depth !== 0) continue;
        const candidate = value.slice(start, index + 1).trim();
        try { if (Array.isArray(JSON.parse(candidate) as unknown)) candidates.push(candidate); } catch { /* Skip text markers such as [FULL TEXT]. */ }
        break;
      }
    }
  }
  return [...new Set(candidates)];
}
function isValidEventExtraction(value: unknown): value is LlmEventRecord[] {
  const allowedKeys = new Set(["title", "summary", "url", "relevanceScore", "relevance_score", "eventDate", "event_date", "eventType", "event_type"]);
  return Array.isArray(value) && value.every((item) => {
    if (!isRecord(item) || Object.keys(item).some((key) => !allowedKeys.has(key))) return false;
    const title = item.title;
    const summary = item.summary;
    const url = item.url;
    const hasCamelScore = Object.prototype.hasOwnProperty.call(item, "relevanceScore");
    const hasSnakeScore = Object.prototype.hasOwnProperty.call(item, "relevance_score");
    const score = hasCamelScore ? item.relevanceScore : item.relevance_score;
    const eventDate = item.eventDate ?? item.event_date;
    const eventType = item.eventType ?? item.event_type;
    const hasBothDateKeys = Object.prototype.hasOwnProperty.call(item, "eventDate") && Object.prototype.hasOwnProperty.call(item, "event_date");
    const hasBothTypeKeys = Object.prototype.hasOwnProperty.call(item, "eventType") && Object.prototype.hasOwnProperty.call(item, "event_type");
    return typeof title === "string" && text(title).length > 0
      && typeof summary === "string" && text(summary).length > 0
      && typeof url === "string" && canonical(url) !== null
      && (hasCamelScore !== hasSnakeScore) && typeof score === "number" && Number.isInteger(score) && score >= 1 && score <= CONFIG.MAX_RELEVANCE_SCORE
      && !hasBothDateKeys && (eventDate === undefined || typeof eventDate === "string")
      && !hasBothTypeKeys && (eventType === undefined || (typeof eventType === "string" && text(eventType).length > 0));
  });
}
function parseEventArray(value: string): ParsedLlmEvents {
  const rawPreview = value.slice(0, 300);
  const direct = value.trim();
  if (!direct) return { ok: false, reason: "empty response", rawPreview };
  try {
    let parsed = JSON.parse(direct) as unknown;
    if (typeof parsed === "string" && (parsed.trim().startsWith("{") || parsed.trim().startsWith("["))) {
      try {
        parsed = JSON.parse(parsed) as unknown;
      } catch {
        // If the serialized JSON string is malformed, keep the original value.
      }
    }
    const eventPayload = isRecord(parsed) && Array.isArray(parsed.candidates) ? parsed.candidates : parsed;
    if (Array.isArray(eventPayload)) {
      if (isValidEventExtraction(eventPayload)) return { ok: true, items: eventPayload };
    } else if (typeof parsed === "object" && parsed !== null) {
      const wrapped = [parsed];
      if (isValidEventExtraction(wrapped)) return { ok: true, items: wrapped };
    }
  } catch {
    // If the complete response is not JSON, continue with candidate extraction below.
  }
  const match = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const attempts: Array<{ level: string; body: string }> = [{ level: "direct", body: direct }];
  if (match?.[1]?.trim()) attempts.push({ level: "markdown", body: match[1].trim() });
  for (const extracted of jsonArrayCandidates(value)) {
    attempts.push({ level: "cleaned", body: extracted });
    const repaired = extracted.replace(/,\s*([\]}])/g, "$1");
    if (repaired !== extracted) attempts.push({ level: "cleaned-trailing-comma", body: repaired });
  }
  const errors: string[] = [];
  for (const attempt of attempts.filter((candidate, index, all) => all.findIndex((item) => item.body === candidate.body) === index)) {
    try {
      const parsed = JSON.parse(attempt.body) as unknown;
      if (!Array.isArray(parsed)) { errors.push(`${attempt.level}: top-level value is not an array`); continue; }
      if (!isValidEventExtraction(parsed)) { errors.push(`${attempt.level}: event schema validation failed`); continue; }
      return { ok: true, items: parsed };
    } catch (error) {
      errors.push(`${attempt.level}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok: false, reason: `all JSON parsing levels failed (${errors.join("; ")})`, rawPreview };
}
function parseArray(value: string): LlmEventRecord[] {
  const parsed = parseEventArray(value);
  if (!parsed.ok) throw new LlmParseError(parsed.reason, parsed.rawPreview);
  return parsed.items;
}
function hasGarbageText(value: string): boolean { return GARBAGE_TEXT.test(value); }
function filterSnippetCandidates(candidates: Candidate[]): Candidate[] {
  return candidates.filter((item) => {
    if (item.extractionMethod !== "snippet-fallback") return true;
    const summary = text(item.llmContext || item.summary);
    const tooShort = [...summary].length < 20;
    const hasGarbage = SNIPPET_GARBAGE_TEXT.test(summary);
    if (!tooShort && !hasGarbage) return true;
    const reason = tooShort && hasGarbage ? "包含垃圾词/过短" : hasGarbage ? "包含垃圾词" : "过短";
    console.warn(`[过滤] 丢弃无效 snippet: ${item.url} (原因: ${reason})`);
    return false;
  });
}
function compactBody(texts: string[], maxChars: number): string { const paragraphs = texts.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean); const output: string[] = []; let length = 0; for (const paragraph of paragraphs) { const extra = output.length ? paragraph.length + 1 : paragraph.length; if (length + extra > maxChars) break; output.push(paragraph); length += extra; } if (!output.length && paragraphs.length) return paragraphs[0].slice(0, maxChars); return output.join("\n"); }
function extractorContext(candidate: Candidate, result: Awaited<ReturnType<typeof extractNews>>): string | null { if (result.method !== "platform-rule" && result.method !== "generic-rule") return null; const body = compactBody(result.item.texts, EXTRACTOR_MAX_CHARS); if (result.item.texts.length === 0 || body.length < EXTRACTOR_MIN_BODY_CHARS) return null; const published = result.item.meta_info.publish_time || candidate.eventDate || "unknown"; return [`title: ${result.item.title || candidate.title}`, `published_at: ${published}`, `source_domain: ${candidate.sourceName || hostname(candidate.url)}`, "body:", body].join("\n"); }
async function enrichCandidates(candidates: Candidate[]): Promise<{ candidates: Candidate[]; stats: ExtractorStats }> { const stats: ExtractorStats = { processed: 0, platformRule: 0, genericRule: 0, fallback: 0, errors: 0 }; if (!EXTRACTOR_ENABLED) return { candidates, stats }; const enriched = await Promise.all(candidates.map((candidate) => extractorLimiter.run(async () => { stats.processed += 1; try { const result = await extractNews(candidate.url, { timeoutMs: CONFIG.NEWS_EXTRACTOR_TIMEOUT_MS, retries: CONFIG.EXTRACTOR_RETRIES, snippet: { title: candidate.title, summary: candidate.summary, publishedAt: candidate.eventDate, sourceName: candidate.sourceName } }); const context = extractorContext(candidate, result); if (context) { if (result.method === "platform-rule") stats.platformRule += 1; else stats.genericRule += 1; return { ...candidate, title: result.item.title || candidate.title, eventDate: eventDate(result.item.meta_info.publish_time, candidate.url) || candidate.eventDate, llmContext: context, extractionMethod: "full-text" as const }; } stats.fallback += 1; return { ...candidate, llmContext: candidate.summary, extractionMethod: "snippet-fallback" as const }; } catch (error) { stats.fallback += 1; stats.errors += 1; console.warn(`[Extractor:${candidate.url}] 请求失败，进入 snippet-fallback: ${error instanceof Error ? error.message : String(error)}`); return { ...candidate, llmContext: candidate.summary, extractionMethod: "snippet-fallback" as const }; } }))); return { candidates: enriched, stats }; }
async function extractEvents(organization: Organization, candidates: Candidate[], days: number): Promise<Candidate[]> { const inputCandidates = filterSnippetCandidates(candidates); if (!inputCandidates.length) return []; const llmCandidates = inputCandidates.map((item) => { const content = item.llmContext || item.summary; const marker = item.extractionMethod === "full-text" ? "[FULL TEXT]" : "[SNIPPET MODE - LIMITED INFO]"; return { title: item.title, url: item.url, summary: `${marker}\n${content}`, eventDate: item.eventDate, sourceName: item.sourceName, extractionMethod: item.extractionMethod }; }); const response = await chatCompletion(`Extract only directly relevant organization news events as a JSON array. Each item must include url,title,summary,event_date,event_type,relevance_score (1-${CONFIG.MAX_RELEVANCE_SCORE}). 仅提取过去 ${days} 天内发生的事件，忽略更早的新闻。只要正文包含该机构相关的实质性动态（合作、发布、人事变动、政策或研究成果），即使页面含少量导航或广告，相关性评分也应 >= 6。 ${CONFIG.MARKER_OUTPUT_INSTRUCTION}`, JSON.stringify({ organization: organization.name, candidates: llmCandidates })); const byUrl = new Map(inputCandidates.map((item) => [item.url, item])); const types: EventType[] = ["report", "partnership", "personnel", "policy", "research", "award", "other"]; const cutoff = Date.now() - days * CONFIG.MILLISECONDS_PER_DAY; return parseArray(response).flatMap((item): Candidate[] => { if (!item || typeof item !== "object") return []; const raw = item as Record<string, unknown>; const url = typeof raw.url === "string" ? canonical(raw.url) : null; const original = url ? byUrl.get(url) : undefined; const title = text(raw.title) || original?.title || ""; const summary = text(raw.summary) || original?.summary || ""; const score = Number(raw.relevance_score ?? raw.relevanceScore); const date = text(raw.event_date ?? raw.eventDate) || original?.eventDate || "unknown"; const parsed = Date.parse(date); if (!url || !original || hasGarbageText(title) || hasGarbageText(summary) || !Number.isInteger(score) || score < MIN_SCORE || score > CONFIG.MAX_RELEVANCE_SCORE || (Number.isFinite(parsed) && parsed < cutoff)) return []; return [{ ...original, url, title, summary, eventDate: date, eventType: types.includes((raw.event_type ?? raw.eventType) as EventType) ? (raw.event_type ?? raw.eventType) as EventType : "other", relevanceScore: score }]; }); }
function dedupe(results: Candidate[]): Candidate[] { const output: Candidate[] = []; const seen = new Set<string>(); for (const item of results.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))) { const key = item.title.toLocaleLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, ""); if (seen.has(item.url) || output.some((x) => key && (x.title.toLocaleLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, "").includes(key) || key.includes(x.title.toLocaleLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, ""))))) continue; seen.add(item.url); output.push(item); } return output.slice(0, CONFIG.MAX_DEDUPE_RESULTS); }
async function discover(organization: Organization, days: number): Promise<DiscoverResult> { const hasWebsite = Boolean(officialUrl(organization.officialDomain)); const collected: Candidate[] = []; for (const query of queries(organization)) { try { collected.push(...await searx(query, days)); } catch (error) { console.error(`[新闻:${organization.name}] 搜索失败`, error); } } if (hasWebsite) { const url = officialUrl(organization.officialDomain); if (url) { try { collected.push(...await pageLinks(url)); } catch (error) { console.warn(`[新闻:${organization.name}] 官网链接读取失败: ${error instanceof Error ? error.message : String(error)}`); } } } collected.push(...await sourceLinks(organization)); const unique = [...new Map(collected.map((item) => [item.url, item])).values()].slice(0, hasWebsite ? MAX_RESULTS : CONFIG.NO_WEBSITE_MAX_RESULTS); const extracted = await enrichCandidates(unique); const llm = await extractEvents(organization, extracted.candidates, days); return { raw: unique.length, llm: llm.length, results: dedupe(llm), extractor: extracted.stats }; }
function taskIdFromArgv(): string { const inline = process.argv.find((arg) => arg.startsWith("--task-id="))?.slice("--task-id=".length); const index = process.argv.indexOf("--task-id"); const value = inline || (index >= 0 ? process.argv[index + 1] : undefined); return value && !value.startsWith("-") ? value : `event_search_${Date.now()}`; }
async function main(): Promise<void> {
  const args = parseArgs();
  const progressPath = progressPathForTask(args.taskId);
  if (args.resume) {
    const previous = readProgress(progressPath, args.taskId);
    console.log(previous ? `[进度:${args.taskId}] 恢复已有任务进度 ${previous.processed}/${previous.total}` : `[进度:${args.taskId}] 未找到可恢复的历史进度，从数据库状态继续`);
  }
  if (DB_PATH !== ":memory:") mkdirSync(dirname(DB_PATH), { recursive: true });
  const client = createClient({ url: DB_PATH === ":memory:" ? "file::memory:" : `file:${DB_PATH}` });
  const db = drizzle(client);
  try {
    const all = await db.select({ entityId: organizations.entityId, slug: organizations.slug, name: organizations.name, officialDomain: organizations.websiteUrl, sources: organizations.sources, lastEventSearchedAt: organizations.lastEventSearchedAt, eventSearchStatus: organizations.eventSearchStatus }).from(organizations).all() as Organization[];
    const cutoff = Date.now() - args.skipHours * 3_600_000;
    const eligible = args.force ? all : all.filter((item) => {
      const stale = !item.lastEventSearchedAt || Date.parse(item.lastEventSearchedAt) < cutoff;
      return args.resume ? item.eventSearchStatus === "pending" || item.eventSearchStatus === "failed" || stale : item.eventSearchStatus === "pending" || stale;
    });
    const pending = eligible.slice(0, args.limit);
    let success = 0; let failed = 0; let processed = 0;
    const manifestSuccess: Array<{ id: string; slug: string; name: string }> = [];
    const manifestFailed: Array<{ id: string; slug: string; name: string; reason: ManifestFailureReason; error: string }> = [];
    await saveProgress({ taskId: args.taskId, total: pending.length, processed: 0, success: 0, failed: 0, currentInstitution: null, status: "running", lastUpdated: new Date().toISOString() }, progressPath);
    const existingRows = await db.select({ organizationId: events.organizationId, sourceUrl: events.sourceUrl }).from(events).all();
    const existing = new Map<string, Set<string>>();
    for (const row of existingRows) { const url = row.sourceUrl ? canonical(row.sourceUrl) : null; if (!url) continue; const set = existing.get(row.organizationId) || new Set<string>(); set.add(url); existing.set(row.organizationId, set); }
    for (const organization of pending) {
      await saveProgress({ taskId: args.taskId, total: pending.length, processed, success, failed, currentInstitution: organization.name, status: "running", lastUpdated: new Date().toISOString() }, progressPath);
      let status: Status = "success";
      let failureStatus: FailureStatus | undefined;
      let failureMessage: string | undefined;
      try {
        const discovered = await discover(organization, args.days);
        if (discovered.raw === 0) {
          manifestFailed.push({ id: organization.entityId, slug: organization.slug, name: organization.name, reason: "no_valid_source", error: "No candidate source returned" });
        } else {
          manifestSuccess.push({ id: organization.entityId, slug: organization.slug, name: organization.name });
        }
        const known = existing.get(organization.entityId) || new Set<string>();
        const fresh = discovered.results.filter((item) => !known.has(item.url));
        let inserted = 0;
        for (const result of fresh) {
          try {
            const writeResult = await db.insert(events).values({ id: randomUUID(), organizationId: organization.entityId, eventDate: result.eventDate, eventType: result.eventType || "other", relevanceScore: result.relevanceScore, title: result.title, summary: result.summary || result.title, sourceUrl: result.url, canonicalSourceUrl: result.url, sourceName: result.sourceName }).onConflictDoNothing({ target: [events.organizationId, events.canonicalSourceUrl] }).run();
            const changes = Number((writeResult as { changes?: unknown; rowsAffected?: unknown }).changes ?? (writeResult as { rowsAffected?: unknown }).rowsAffected ?? 1);
            if (changes > 0) inserted += 1; else console.log(`[入库] 机构 ${organization.name}: 事件 URL 已存在，跳过 "${result.url}"`);
          } catch (error) {
            if (/unique|constraint|conflict/i.test(error instanceof Error ? error.message : String(error))) console.log(`[入库] 机构 ${organization.name}: 事件 URL 已存在，跳过 "${result.url}"`);
            else throw error;
          }
          known.add(result.url);
        }
        existing.set(organization.entityId, known);
        const extractorLog = EXTRACTOR_ENABLED ? ` -> Extractor处理 ${discovered.extractor.processed} (平台规则 ${discovered.extractor.platformRule}, 通用 ${discovered.extractor.genericRule}, Fallback ${discovered.extractor.fallback})` : "";
        console.log(`[漏斗] 机构 ${organization.name}: 原始候选 ${discovered.raw}${extractorLog} -> LLM评分后保留 ${discovered.llm} -> 幂等入库 ${inserted}`);
        success += 1;
      } catch (error) {
        status = "failed";
        failureStatus = error instanceof LlmParseError ? error.code : "failed";
        failureMessage = error instanceof Error ? error.message : String(error);
        failed += 1;
        manifestFailed.push({ id: organization.entityId, slug: organization.slug, name: organization.name, reason: manifestFailureReason(error), error: failureMessage });
        if (error instanceof LlmParseError) {
          console.error(`[LLM:${organization.name}] llm_parse_failed: ${error.reason}; 原始响应前 ${error.rawPreview.length} 个字符: ${JSON.stringify(error.rawPreview)}`);
          if (DEBUG_LLM_FULL_OUTPUT && lastLlmTrace) {
            console.error(`[DEBUG-LLM-FULL] 机构 ${organization.name}: System Prompt (完整)\n${lastLlmTrace.systemPrompt}`);
            console.error(`[DEBUG-LLM-FULL] 机构 ${organization.name}: User Input (完整)\n${lastLlmTrace.userPrompt}`);
            console.error(`[DEBUG-LLM-FULL] 机构 ${organization.name}: Raw Output (完整)\n${lastLlmTrace.rawOutput}`);
          }
        } else {
          console.error(`[新闻:${organization.name}] 处理失败`, error);
        }
      }
      const now = new Date().toISOString();
      await db.update(organizations).set({ lastEventSearchedAt: now, eventSearchStatus: status, updatedAt: now }).where(eq(organizations.entityId, organization.entityId)).run();
      processed += 1;
      await saveProgress({ taskId: args.taskId, total: pending.length, processed, success, failed, currentInstitution: organization.name, status: processed === pending.length ? "completed" : "running", message: failureMessage, errorMessage: failureMessage, lastFailureStatus: failureStatus, lastUpdated: now }, progressPath);
    }
    if (!pending.length) await saveProgress({ taskId: args.taskId, total: 0, processed: 0, success: 0, failed: 0, currentInstitution: null, status: "completed", lastUpdated: new Date().toISOString() }, progressPath);
    const manifest = { schemaVersion: "organization-run-manifest/v1", taskId: args.taskId, generatedAt: new Date().toISOString(), success: manifestSuccess, failed: manifestFailed };
    const manifestPath = manifestPathForTask(args.taskId);
    writeManifest(manifestPath, manifest);
    console.log(`[manifest] success=${manifest.success.length} failed=${manifest.failed.length} path=${manifestPath}`);
  } finally { client.close(); }
}
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const taskId = taskIdFromArgv();
  const progressPath = progressPathForTask(taskId);
  try {
    const current = readProgress(progressPath, taskId);
    saveProgress({ taskId, total: current?.total || 0, processed: current?.processed || 0, success: current?.success || 0, failed: current?.failed || 0, currentInstitution: current?.currentInstitution || null, status: "failed", message, errorMessage: message, lastFailureStatus: message.startsWith("llm_parse_failed:") ? "llm_parse_failed" : "failed", lastUpdated: new Date().toISOString() }, progressPath);
  } catch (progressError) { console.error(`[事件搜索:${taskId}] 失败状态写入失败`, progressError); }
  console.error(`[事件搜索:${taskId}] 任务失败`, error);
  process.exitCode = 1;
});
