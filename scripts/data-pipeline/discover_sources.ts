#!/usr/bin/env npx tsx

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";
// @ts-expect-error minimist 1.x does not ship TypeScript declarations.
import minimist from "minimist";
import { cancelResponseBody, createLimiter, fetchControlled, logActiveSockets } from "../../lib/http-control";
import { verifyCandidateHomepage } from "../../lib/source-quality";
import { aggregateSearxngResults, checkSearxngPool, parseSearxngUrls } from "../../lib/searxng-pool";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INPUT = resolve(ROOT, "data/raw_organizations.json");
const OUTPUT = resolve(ROOT, "data/organization_sources_secure.json");
const PROGRESS = resolve(ROOT, "data/search_progress.json");
const WHITELIST = resolve(ROOT, "data/known_domains_whitelist.json");
const DB_PATH = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(ROOT, ".local/d1.sqlite");
const TIMEOUT = Number(process.env.DISCOVERY_TIMEOUT_MS) || 10_000;
const MAX_RESPONSE = Number(process.env.DISCOVERY_MAX_RESPONSE_BYTES) || 512 * 1024;
const SEARXNG_URLS = parseSearxngUrls({ SEARXNG_URLS: process.env.SEARXNG_URLS, SEARXNG_URL: process.env.SEARXNG_URL });
const ENGINES = (process.env.SEARXNG_ENGINES || "google,bing,duckduckgo,baidu,startpage,qwant").split(",").map((value) => value.trim()).filter(Boolean);
const searchLimiter = createLimiter(Number(process.env.SEARXNG_CONCURRENCY) || 8);
const homepageLimiter = createLimiter(Number(process.env.HOMEPAGE_CONCURRENCY) || 4);
const blockedDomains = [
  "wikipedia.org",
  "baidu.com",
  "zhihu.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "threads.com",
  "threads.net",
  "linkedin.com",
  "youtube.com",
  "qq.com",
  "sina.com.cn",
  "sohu.com",
  "163.com",
  "ifeng.com",
  "thepaper.cn",
  "toutiao.com",
  "weibo.com",
  "douyin.com",
];

type Organization = { entityId?: string; slug?: string; originalName: string; identifier: string };
type Hit = { url: string; title?: string; content?: string };
type Result = { name: string; status: string; checkedAt: string; official_domain: string | null; candidates: string[]; sources: Array<{ url: string; type: string }>; error?: string };
type SearchProgress = { taskId: string; total: number; processed: number; success: number; failed: number; currentInstitution: string | null; status: "starting" | "running" | "completed" | "failed"; message?: string; lastUpdated: string };
type WhitelistEntry = { name?: string; code?: string; aliases?: string[]; official_domain?: string; domain?: string };
let client: Client | undefined;

function db(): Client { if (!client) client = createClient({ url: DB_PATH === ":memory:" ? "file::memory:" : `file:${DB_PATH}` }); return client; }
function clean(value: string): string { return value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim(); }
function normalize(value: string): string { return clean(value).toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, ""); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function safeTaskId(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96) || "default"; }
function failureReason(result: Result): string {
  const message = result.error || "";
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return "network_timeout";
  if (/network|ECONN|fetch failed|HTTP 5\d\d/i.test(message)) return "network_error";
  if (/parse|JSON|schema/i.test(message)) return "llm_parse_failed";
  return result.status === "unverified" ? "no_valid_source" : "processing_failed";
}
function safeUrl(value: string): URL | null { try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:" ? url : null; } catch { return null; } }
function blocked(host: string): boolean { const value = host.toLocaleLowerCase().replace(/^www\./, ""); return blockedDomains.some((domain) => value === domain || value.endsWith(`.${domain}`)); }
function log(message: string): void { console.log(message); }
async function saveProgress(progress: SearchProgress): Promise<void> {
  await mkdir(dirname(PROGRESS), { recursive: true });
  const temporaryPath = `${PROGRESS}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
  const body = `${JSON.stringify({ ...progress, lastUpdated: new Date().toISOString() }, null, 2)}\n`;
  try {
    await writeFile(temporaryPath, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await rename(temporaryPath, PROGRESS);
    } catch {
      await writeFile(PROGRESS, body, { encoding: "utf8", mode: 0o600 });
      await unlink(temporaryPath).catch(() => undefined);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
async function writeAtomic(path: string, body: string): Promise<void> {
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
  try { await writeFile(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 }); try { await rename(temporary, path); } catch { await writeFile(path, body, { encoding: "utf8", mode: 0o600 }); await unlink(temporary).catch(() => undefined); } }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

async function requestJson(url: string): Promise<unknown> {
  let response: Response | undefined;
  try {
    response = await fetchControlled(url, { headers: { accept: "application/json" }, redirect: "manual" }, TIMEOUT);
    const status = response.status;
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${status}: ${text.slice(0, 200)}`);
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE) throw new Error(`response exceeds ${MAX_RESPONSE} bytes`);
    return JSON.parse(text);
  } finally { if (response) await cancelResponseBody(response); }
}

function queriesFor(name: string): string[] { const value = clean(name); return [`"${value} 官网"`, `"${value} official website"`, `"${value}" site:*.edu OR site:*.gov`]; }

async function search(urls: string[], organization: Organization, query: string): Promise<Hit[]> {
  log(`[搜索] 机构 ${organization.originalName}: 构造查询词 "${query}"`);
  const hits = await aggregateSearxngResults(urls, query, { query: (base) => searchLimiter.run(async () => {
    const params = new URLSearchParams({ q: query, format: "json", categories: "general", engines: ENGINES.join(",") });
    try {
      const payload = await requestJson(`${base}/search?${params}`) as { results?: unknown[] };
      const rows = Array.isArray(payload.results) ? payload.results : [];
      log(`[搜索] 机构 ${organization.originalName}: SearXNG 返回 ${rows.length} 条结果`);
      return rows.flatMap((item): Hit[] => { if (!item || typeof item !== "object") return []; const row = item as Record<string, unknown>; return typeof row.url === "string" ? [{ url: row.url, title: typeof row.title === "string" ? row.title : undefined, content: typeof row.content === "string" ? row.content : undefined }] : []; });
    } catch (error) { log(`[搜索] 机构 ${organization.originalName}: SearXNG 返回 0 条结果 (HTTP 状态/错误: ${errorMessage(error)})`); return []; }
  }) });
  log(`[搜索] 机构 ${organization.originalName}: 聚合后 ${hits.length} 条结果`);
  return hits;
}

async function readOrganizations(): Promise<Organization[]> {
  const values: Organization[] = [];
  try {
    const rows = await db().execute("SELECT entity_id, slug, name FROM organizations ORDER BY name");
    rows.rows.forEach((row, index) => { const name = clean(String(row.name || "")); if (index < 5) log(`[输入] 数据库机构 ${index + 1}: name="${name}" entity_id="${String(row.entity_id || "")}"`); if (name) values.push({ originalName: name, identifier: clean(String(row.slug || row.entity_id || name)) }); });
    if (values.length) { log(`[输入] 从 organizations 表读取 ${values.length} 个机构`); return values; }
  } catch (error) { log(`[输入] 数据库读取失败，回退 JSON: ${errorMessage(error)}`); }
  const raw = JSON.parse(await readFile(INPUT, "utf8")) as unknown;
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === "object" && Array.isArray((raw as { organizations?: unknown[] }).organizations) ? (raw as { organizations: unknown[] }).organizations : []);
  list.forEach((item, index) => { const row = typeof item === "string" ? { name: item } : (item && typeof item === "object" ? item as Record<string, unknown> : {}); const name = clean(String(row.name || row.code || "")); if (index < 5) log(`[输入] JSON 机构 ${index + 1}: name="${name}"`); if (name) values.push({ originalName: name, identifier: clean(String(row.code || name)) }); });
  log(`[输入] 从 ${INPUT} 读取 ${values.length} 个机构`);
  return values;
}

async function readWhitelist(): Promise<WhitelistEntry[]> { try { const raw = JSON.parse(await readFile(WHITELIST, "utf8")) as { organizations?: unknown[]; institutions?: unknown[] }; return (raw.organizations || raw.institutions || []).filter((item): item is WhitelistEntry => Boolean(item && typeof item === "object")); } catch { return []; } }
function whitelistResult(org: Organization, entries: WhitelistEntry[]): Result | undefined {
  const key = normalize(org.originalName); const entry = entries.find((item) => [item.name, item.code, ...(item.aliases || [])].filter(Boolean).some((value) => normalize(String(value)) === key)); const domain = entry?.official_domain || entry?.domain; const url = domain ? safeUrl(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`) : null;
  if (!url || blocked(url.hostname)) return undefined;
  return { name: org.identifier, status: "whitelist_match", checkedAt: new Date().toISOString(), official_domain: url.hostname.replace(/^www\./, ""), candidates: [], sources: [{ url: `${url.origin}/`, type: "whitelist_match" }] };
}
async function readCachedResult(org: Organization): Promise<Result | undefined> {
  if (!existsSync(OUTPUT)) return undefined;
  try { const raw = JSON.parse(await readFile(OUTPUT, "utf8")) as { organizations?: Result[] }; const result = (raw.organizations || []).find((item) => normalize(item.name) === normalize(org.originalName) || normalize(item.name) === normalize(org.identifier)); if (!result?.official_domain) return undefined; const url = safeUrl(`https://${result.official_domain}`); if (!url || blocked(url.hostname)) return undefined; log(`[回退] 机构 ${org.originalName}: 使用缓存候选源 ${url.origin}/`); return { ...result, name: org.identifier, status: "cache_match", sources: [{ url: `${url.origin}/`, type: "cache" }] }; } catch { return undefined; }
}

async function discover(org: Organization, urls: string[], whitelist: WhitelistEntry[]): Promise<Result> {
  const direct = whitelistResult(org, whitelist); if (direct) return direct;
  const candidates: string[] = [];
  for (const query of queriesFor(org.originalName)) {
    const hits = await search(urls, org, query); candidates.push(...hits.map((hit) => hit.url));
    for (const hit of hits) {
      const url = safeUrl(hit.url);
      if (!url) { log(`[筛选] 机构 ${org.originalName}: 候选 URL "${hit.url}" -> 判定为非官网 (原因: URL 无效)`); continue; }
      if (blocked(url.hostname)) { log(`[筛选] 机构 ${org.originalName}: 候选 URL "${hit.url}" -> 判定为非官网 (原因: 聚合/社交域名)`); continue; }
      const identity = { name: org.originalName, aliases: [org.identifier] };
      const verified = await homepageLimiter.run(() => verifyCandidateHomepage(hit.url, identity, { loose: true, timeoutMs: TIMEOUT }));
      const resultText = normalize(`${hit.title || ""} ${hit.content || ""}`);
      const nameEvidence = resultText.includes(normalize(org.originalName)) || resultText.includes(normalize(org.identifier));
      const institutional = /\.(edu|ac|gov)(\.|$)/i.test(url.hostname) || /university|institute|college|academy|官网|大学|学院|研究/i.test(resultText);
      if (verified || (institutional && nameEvidence)) { log(`[筛选] 机构 ${org.originalName}: 候选 URL "${hit.url}" -> 判定为官网 (原因: ${verified ? "主页内容验证通过" : "机构名称+教育/政府标记"})`); return { name: org.identifier, status: "online_verified", checkedAt: new Date().toISOString(), official_domain: url.hostname.replace(/^www\./, ""), candidates: [...new Set(candidates)].slice(0, 8), sources: [{ url: `${url.origin}/`, type: "search" }] }; }
      log(`[筛选] 机构 ${org.originalName}: 候选 URL "${hit.url}" -> 判定为非官网 (原因: 主页未找到机构名或核心关键词)`);
    }
  }
  const cached = await readCachedResult(org); if (cached) return cached;
  return { name: org.identifier, status: "unverified", checkedAt: new Date().toISOString(), official_domain: null, candidates: [...new Set(candidates)].slice(0, 8), sources: [] };
}
function resultWebsiteUrl(result: Result): string | null {
  if (!["online_verified", "whitelist_match", "cache_match"].includes(result.status)) return null;
  const candidate = result.sources.find((source) => Boolean(source.url))?.url || (result.official_domain ? `https://${result.official_domain}` : "");
  const url = safeUrl(candidate);
  if (!url || blocked(url.hostname)) return null;
  return `${url.origin}/`;
}

async function persistDatabaseResult(org: Organization, result: Result, overwrite: boolean): Promise<void> {
  try {
    const keys = [org.identifier, org.originalName];
    const current = await db().execute({
      sql: "SELECT website_url FROM organizations WHERE entity_id = ? OR slug = ? OR name = ? LIMIT 1",
      args: [org.identifier, org.identifier, org.originalName],
    });
    const oldValue = current.rows[0]?.website_url == null ? null : String(current.rows[0].website_url).trim() || null;
    const nextValue = resultWebsiteUrl(result);
    const shouldWriteWebsite = Boolean(nextValue && (!oldValue || overwrite));
    if (shouldWriteWebsite && nextValue) {
      log(`[写入] 机构 ${org.originalName}: 更新官网为 "${nextValue}" (原值为 ${oldValue ? `"${oldValue}" 被 --overwrite 强制替换` : "null"})`);
    } else if (oldValue) {
      log(`[写入] 机构 ${org.originalName}: 保留原有官网 (本次搜索未找到更优结果)`);
    } else if (!nextValue) {
      log(`[写入] 机构 ${org.originalName}: 保留原有官网 (原值为 null，本次搜索未找到有效官网)`);
    }
    const now = new Date().toISOString();
    const updateSql = shouldWriteWebsite
      ? "UPDATE organizations SET website_url = ?, last_searched_at = ?, search_status = ?, updated_at = ? WHERE entity_id = ? OR slug = ? OR name = ?"
      : "UPDATE organizations SET last_searched_at = ?, search_status = ?, updated_at = ? WHERE entity_id = ? OR slug = ? OR name = ?";
    const updateArgs = shouldWriteWebsite
      ? [nextValue, now, ["online_verified", "whitelist_match", "cache_match"].includes(result.status) ? "success" : "failed", now, ...keys]
      : [now, ["online_verified", "whitelist_match", "cache_match"].includes(result.status) ? "success" : "failed", now, ...keys];
    await db().execute({ sql: updateSql, args: updateArgs });
  } catch (error) {
    log(`[数据库] 更新 ${org.originalName} 失败: ${errorMessage(error)}`);
  }
}

async function main(): Promise<void> {
  const args = minimist(process.argv.slice(2), { string: ["limit", "task-id"], boolean: ["force", "overwrite"] });
  const taskId = typeof args["task-id"] === "string" ? args["task-id"] : `discover_${process.pid}`;
  const overwrite = Boolean(args.overwrite);
  await saveProgress({ taskId, total: 0, processed: 0, success: 0, failed: 0, currentInstitution: null, status: "starting", lastUpdated: new Date().toISOString() });
  const all = await readOrganizations();
  const limit = args.limit === undefined ? all.length : Math.max(0, Number(args.limit) || 0);
  const organizations = all.slice(0, limit);
  const configured = SEARXNG_URLS.length ? SEARXNG_URLS : ["http://localhost:8080"];
  const pool = await checkSearxngPool(configured);
  pool.failed.forEach(({ url, reason }) => log(`[SearXNG] 实例不可用: ${url} (${reason})`));
  const urls = pool.healthyUrls.length ? pool.healthyUrls : configured;
  const whitelist = await readWhitelist();
  const results: Result[] = [];
  let success = 0;
  await saveProgress({ taskId, total: organizations.length, processed: 0, success, failed: 0, currentInstitution: null, status: "running", lastUpdated: new Date().toISOString() });
  for (const [index, org] of organizations.entries()) {
    log(`[机构] 正在处理 ${org.originalName} (${index + 1}/${organizations.length})`);
    await saveProgress({ taskId, total: organizations.length, processed: index, success, failed: index - success, currentInstitution: org.originalName, status: "running", lastUpdated: new Date().toISOString() });
    let result: Result;
    try { result = await discover(org, urls, whitelist); } catch (error) { result = { name: org.identifier, status: "error", checkedAt: new Date().toISOString(), official_domain: null, candidates: [], sources: [], error: errorMessage(error) }; log(`[发现失败] 机构 ${org.originalName}: ${errorMessage(error)}`); }
    results.push(result);
    await persistDatabaseResult(org, result, overwrite);
    if (["online_verified", "whitelist_match", "cache_match"].includes(result.status)) success += 1;
    await saveProgress({ taskId, total: organizations.length, processed: index + 1, success, failed: index + 1 - success, currentInstitution: org.originalName, status: "running", lastUpdated: new Date().toISOString() });
    if ((index + 1) % 10 === 0) logActiveSockets(`discover ${index + 1}/${organizations.length}`);
  }
  await mkdir(dirname(OUTPUT), { recursive: true }); await writeFile(OUTPUT, `${JSON.stringify({ schemaVersion: "organization-sources-secure/v1", generatedAt: new Date().toISOString(), organizations: results }, null, 2)}\n`, { mode: 0o600 });
  const successfulStatuses = new Set(["online_verified", "whitelist_match", "cache_match"]);
  const manifest = {
    schemaVersion: "organization-run-manifest/v1",
    taskId,
    generatedAt: new Date().toISOString(),
    success: results.filter((result) => successfulStatuses.has(result.status)).map((result, index) => { const org = organizations[index] || organizations.find((item) => item.identifier === result.name); return { id: org?.entityId || org?.identifier || result.name, slug: org?.slug || org?.identifier || result.name, name: org?.originalName || result.name }; }),
    failed: results.filter((result) => !successfulStatuses.has(result.status)).map((result, index) => { const org = organizations[index] || organizations.find((item) => item.identifier === result.name); return { id: org?.entityId || org?.identifier || result.name, slug: org?.slug || org?.identifier || result.name, name: org?.originalName || result.name, reason: failureReason(result), error: result.error || null }; }),
  };
  const manifestPath = resolve(ROOT, "data", `organization_discovery_manifest_${safeTaskId(taskId)}.json`);
  await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await saveProgress({ taskId, total: organizations.length, processed: organizations.length, success, failed: organizations.length - success, currentInstitution: null, status: "completed", lastUpdated: new Date().toISOString() });
  client?.close(); log(`[完成] 成功 ${success}/${results.length}，结果已写入 ${OUTPUT}`);
}
main().catch(async (error) => {
  const message = errorMessage(error);
  try {
    const current = JSON.parse(await readFile(PROGRESS, "utf8")) as Partial<SearchProgress>;
    await saveProgress({ taskId: current.taskId || `discover_${process.pid}`, total: current.total || 0, processed: current.processed || 0, success: current.success || 0, failed: current.failed || 0, currentInstitution: current.currentInstitution || null, status: "failed", message, lastUpdated: new Date().toISOString() });
  } catch { /* Preserve the original task failure when progress cannot be written. */ }
  console.error(error); process.exitCode = 1;
});
