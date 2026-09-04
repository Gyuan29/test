/** Enrich organization descriptions from official and discovered public sources. */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { organizations } from "../../db/schema";
import { chatCompletion } from "../../lib/llm-client";
import { fetchExternalUrl } from "../../lib/security-url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const databasePath = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(projectRoot, ".local", "d1.sqlite");
const progressPath = resolve(projectRoot, "data", "enrich_progress.json");
const sourcesPath = resolve(projectRoot, "data", "organization_sources_secure.json");
const MAX_TEXT_LENGTH = Number(process.env.ENRICH_MAX_TEXT_LENGTH) || 6000;
// Organization profile pages frequently take longer than ordinary API requests.
const REQUEST_TIMEOUT_MS = Number(process.env.ENRICH_REQUEST_TIMEOUT_MS) || 20_000;
const REQUEST_DELAY_MS = Number(process.env.ENRICH_REQUEST_DELAY_MS) || 1500;
const LLM_TIMEOUT_MS = Number(process.env.ENRICH_LLM_TIMEOUT_MS) || 120_000;
const MAX_SEARCH_RESULTS = 3;
const MIN_PAGE_TEXT_LENGTH = 20;
const MIN_DESCRIPTION_LENGTH = 80;
const RETRY_DELAYS_MS = [2_000, 5_000] as const;
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
] as const;
const DESCRIPTION_SYSTEM_PROMPT = `你是机构情报编辑。根据提供的网页文本，输出严格的结构化 Markdown，不能输出代码围栏、前言或免责声明。必须使用以下模板和字段（未知信息填写“未查证”）：
## 机构简介
- **全称**：[机构英文/中文全称]
- **成立时间**：[年份或未查证]
- **核心领域**：[关键词1, 关键词2]
- **简介**：[约 200 字的流畅中文介绍，涵盖机构性质、主要成就和研究方向]`;
const RAW_TEXT_PREFIX = "[自动抓取] ";

type Progress = { successfulIds: string[]; updatedAt: string };
type Candidate = { entityId: string; name: string; description: string | null; officialDomain: string | null };
type SourceRecord = { name?: unknown; candidates?: unknown; sources?: unknown };
type SourceUrl = { url: string; kind: "官网" | "候选源" | "临时搜索" };
type ScrapeResult = { text: string; source: SourceUrl };
type HtmlLoader = (html: string) => { (selector: string): { remove(): void; text(): string } };

class PageFetchError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "PageFetchError";
  }
}

let loadHtml: HtmlLoader | undefined;
let sourceIndex: Map<string, SourceRecord> | undefined;

async function getHtmlLoader(): Promise<HtmlLoader> {
  if (loadHtml) return loadHtml;
  const cheerio = await import("cheerio");
  loadHtml = cheerio.load as unknown as HtmlLoader;
  return loadHtml;
}

function parseArgs(): { limit?: number; resume: boolean; force: boolean } {
  const args = process.argv.slice(2);
  const limitIndex = args.indexOf("--limit");
  let limit: number | undefined;
  if (limitIndex >= 0) {
    const value = Number(args[limitIndex + 1]);
    if (!Number.isInteger(value) || value < 1) throw new Error("--limit must be a positive integer");
    limit = value;
  }
  return { limit, resume: args.includes("--resume"), force: args.includes("--force") };
}

function readProgress(resume: boolean): Progress {
  if (!resume) return { successfulIds: [], updatedAt: new Date().toISOString() };
  try {
    const parsed = JSON.parse(readFileSync(progressPath, "utf8")) as Partial<Progress>;
    return { successfulIds: Array.isArray(parsed.successfulIds) ? parsed.successfulIds.filter((value): value is string => typeof value === "string") : [], updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString() };
  } catch { return { successfulIds: [], updatedAt: new Date().toISOString() }; }
}

function saveProgress(progress: Progress): void {
  progress.updatedAt = new Date().toISOString();
  mkdirSync(dirname(progressPath), { recursive: true });
  const body = `${JSON.stringify(progress, null, 2)}\n`;
  const temporaryPath = `${progressPath}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, body, { encoding: "utf8", flag: "wx" });
    try {
      renameSync(temporaryPath, progressPath);
    } catch (error) {
      console.error(`[进度] 原子替换失败，尝试兼容性写入: ${error instanceof Error ? error.message : String(error)}`);
      writeFileSync(progressPath, body, "utf8");
      try { unlinkSync(temporaryPath); } catch { /* The fallback may have already moved or removed it. */ }
    }
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* Preserve the original write error. */ }
    throw error;
  }
}

function normalizeDomain(value: string | null): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
    return url.hostname ? url.hostname.toLowerCase() : null;
  } catch { return null; }
}

function candidateUrls(domain: string): string[] {
  const origin = `https://${domain}`;
  return [`${origin}/`, `${origin}/about`, `${origin}/about-us`];
}

function loadSources(): Map<string, SourceRecord> {
  if (sourceIndex) return sourceIndex;
  sourceIndex = new Map();
  if (!existsSync(sourcesPath)) return sourceIndex;
  try {
    const parsed = JSON.parse(readFileSync(sourcesPath, "utf8")) as { organizations?: SourceRecord[] };
    for (const record of parsed.organizations || []) {
      if (typeof record.name === "string" && record.name.trim()) sourceIndex.set(record.name.trim().toLocaleLowerCase(), record);
    }
  } catch (error) { console.warn(`[来源] 无法读取 ${sourcesPath}: ${error instanceof Error ? error.message : String(error)}`); }
  return sourceIndex;
}

function discoveredUrls(name: string): string[] {
  const record = loadSources().get(name.trim().toLocaleLowerCase());
  if (!record) return [];
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  const sources = Array.isArray(record.sources) ? record.sources.flatMap((item) => item && typeof item === "object" && typeof (item as { url?: unknown }).url === "string" ? [(item as { url: string }).url] : []) : [];
  return [...new Set([...candidates, ...sources].filter((url): url is string => typeof url === "string" && /^https?:\/\//i.test(url)))].slice(0, 12);
}

const LOW_QUALITY_DOMAINS = [
  "zhihu.com", "twitter.com", "x.com", "facebook.com", "weibo.com", "reddit.com", "quora.com", "medium.com", "wordpress.com", "blogspot.com", "tiktok.com", "instagram.com",
] as const;
const LOW_QUALITY_HOST_LABELS = new Set(["blog", "blogs", "forum", "forums", "bbs"]);
const PREFERRED_DOMAINS = ["wikipedia.org", "linkedin.com", "crunchbase.com"] as const;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function hostnameFor(url: string): string | null {
  try { return new URL(url).hostname.toLocaleLowerCase(); } catch { return null; }
}

function isDomainOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function isLowQualityUrl(url: string): boolean {
  const hostname = hostnameFor(url);
  return !hostname || LOW_QUALITY_DOMAINS.some((domain) => isDomainOrSubdomain(hostname, domain)) || hostname.split(".").some((label) => LOW_QUALITY_HOST_LABELS.has(label));
}

function sourcePriority(url: string, officialDomain: string | null): number {
  const hostname = hostnameFor(url);
  if (!hostname) return Number.MAX_SAFE_INTEGER;
  if (officialDomain && isDomainOrSubdomain(hostname, officialDomain)) return 0;
  if (PREFERRED_DOMAINS.some((domain) => isDomainOrSubdomain(hostname, domain))) return 1;
  if (hostname.endsWith(".gov") || hostname.endsWith(".edu")) return 2;
  if (hostname.endsWith(".org")) return 3;
  return 4;
}

function rankUrls(urls: string[], officialDomain: string | null): string[] {
  return [...new Set(urls)].sort((left, right) => sourcePriority(left, officialDomain) - sourcePriority(right, officialDomain));
}

function normalizeForComparison(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, "");
}

function containsOrganizationName(text: string, name: string): boolean {
  const normalizedName = normalizeForComparison(name);
  return normalizedName.length > 1 && normalizeForComparison(text).includes(normalizedName);
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof PageFetchError) return error.retryable;
  const message = errorReason(error);
  return /HTTP (?:400|403|408|429|5\d{2})\b|timeout|timed out|aborted|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(message);
}

async function fetchPage(url: string, name: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const userAgent = USER_AGENTS[Math.min(attempt, USER_AGENTS.length - 1)];
      const response = await fetchExternalUrl(url, {
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: { accept: "text/html,application/xhtml+xml", "user-agent": userAgent },
      });
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* The response body may already be consumed. */ }
        throw new PageFetchError(`HTTP ${response.status}`, response.status === 400 || response.status === 403 || response.status === 408 || response.status === 429 || response.status >= 500);
      }
      const html = await response.text();
      const $ = (await getHtmlLoader())(html);
      $("script, style, noscript, svg, form, nav, footer, header").remove();
      const cleaned = $("body").text().replace(/\s+/g, " ").trim();
      if (cleaned.length >= 200) return cleaned.slice(0, MAX_TEXT_LENGTH);
      const fallback = (await getHtmlLoader())(html);
      fallback("script, style, noscript").remove();
      return fallback("body").text().replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_DELAYS_MS.length || !isRetryableError(error)) break;
      const delay = RETRY_DELAYS_MS[attempt];
      const retryNumber = attempt + 2;
      const suffix = /HTTP 403\b/.test(errorReason(error)) ? "，更换 User-Agent" : "";
      console.warn(`[重试] 机构 ${name}: 第 ${retryNumber} 次重试 (${errorReason(error)})，等待 ${delay / 1000} 秒...${suffix}`);
      await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(errorReason(lastError));
}

async function searchQuery(query: string, name: string): Promise<string[]> {
  const urls: string[] = [];
  const braveKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (braveKey) {
    try {
      const response = await fetchExternalUrl(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_SEARCH_RESULTS}`, {
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: { accept: "application/json", "X-Subscription-Token": braveKey },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { web?: { results?: Array<{ url?: string }> } };
      urls.push(...(body.web?.results || []).flatMap((item) => typeof item.url === "string" ? [item.url] : []));
    } catch (error) { console.warn(`[搜索] 机构 ${name}: Brave 失败 (${errorReason(error)})`); }
  }
  const endpoints = (process.env.SEARXNG_URLS || process.env.SEARXNG_URL || "").split(",").map((value) => value.trim()).filter(Boolean);
  for (const endpoint of endpoints.slice(0, 2)) {
    try {
      const response = await fetchExternalUrl(`${endpoint.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json`, { timeoutMs: REQUEST_TIMEOUT_MS, headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { results?: Array<{ url?: string }> };
      urls.push(...(body.results || []).flatMap((item) => typeof item.url === "string" ? [item.url] : []));
    } catch (error) { console.warn(`[搜索] 机构 ${name}: SearXNG 失败 (${errorReason(error)})`); }
  }
  return [...new Set(urls)];
}

async function trySources(name: string, sources: SourceUrl[], requireName: boolean): Promise<{ result: ScrapeResult | null; reason: string }> {
  let reason = "没有可用来源";
  for (const source of sources) {
    if (source.kind === "候选源" && isLowQualityUrl(source.url)) {
      reason = "域名位于低质量黑名单";
      console.warn(`[来源] 机构 ${name}: 跳过低质量候选源 (${source.url})`);
      continue;
    }
    try {
      const text = await fetchPage(source.url, name);
      if (text.length < MIN_PAGE_TEXT_LENGTH) {
        reason = `正文仅 ${text.length} 字符`;
        continue;
      }
      if (requireName && !containsOrganizationName(text, name)) {
        reason = "未找到机构名";
        console.warn(`[来源] 机构 ${name}: 无效来源 (${source.url})，页面未包含机构名`);
        continue;
      }
      return { result: { text, source }, reason: "" };
    } catch (error) {
      reason = errorReason(error);
      console.warn(`[来源] 机构 ${name}: 抓取失败 (${source.url}: ${reason})`);
    }
  }
  return { result: null, reason };
}

async function searchOrganization(name: string, officialDomain: string | null): Promise<ScrapeResult | null> {
  const queries = [
    `"${name}" 简介 site:wikipedia.org`,
    `"${name}" about site:*.org OR site:*.gov`,
    `"${name}" 官网`,
    `"${name}" official website`,
  ];
  let remaining = MAX_SEARCH_RESULTS;
  for (const query of queries) {
    if (remaining === 0) break;
    console.log(`[搜索] 机构 ${name}: 使用查询 ${query}`);
    const urls = rankUrls(await searchQuery(query, name), officialDomain)
      .filter((url) => !isLowQualityUrl(url))
      .slice(0, remaining);
    if (urls.length === 0) continue;
    const attempt = await trySources(name, urls.map((url) => ({ url, kind: "临时搜索" as const })), true);
    if (attempt.result) return attempt.result;
    remaining -= urls.length;
  }
  return null;
}

async function scrapeOrganization(name: string, domain: string | null): Promise<ScrapeResult> {
  if (domain) {
    const official = await trySources(name, candidateUrls(domain).map((url) => ({ url, kind: "官网" as const })), false);
    if (official.result) return official.result;
    console.log(`[降级] 机构 ${name}: 官网抓取失败 (${official.reason})，尝试候选源...`);
  } else {
    console.log(`[降级] 机构 ${name}: 官网缺失，尝试候选源...`);
  }

  const candidateUrlsForOrganization = rankUrls(discoveredUrls(name), domain);
  if (candidateUrlsForOrganization.length === 0) {
    console.log(`[降级] 机构 ${name}: 候选源为空，触发临时搜索...`);
  } else {
    const candidates = await trySources(name, candidateUrlsForOrganization.map((url) => ({ url, kind: "候选源" as const })), true);
    if (candidates.result) return candidates.result;
    console.log(`[降级] 机构 ${name}: 候选源质量差 (${candidates.reason})，触发临时搜索...`);
  }

  const searchResult = await searchOrganization(name, domain);
  if (searchResult) return searchResult;
  throw new Error("没有可用来源：官网、候选源及临时搜索均未返回包含机构名的有效页面");
}

function normalizeDescription(value: string, name: string): string {
  const cleaned = value.replace(/^```(?:markdown)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (/##\s*机构简介/.test(cleaned)) return cleaned;
  return `## 机构简介\n- **全称**：${name}\n- **成立时间**：未查证\n- **核心领域**：未查证\n- **简介**：${cleaned || "未查证"}`;
}

async function generateDescription(name: string, sourceText: string): Promise<string> {
  const raw = await chatCompletion(DESCRIPTION_SYSTEM_PROMPT, `机构名称：${name}\n网页可见文本：\n${sourceText}`, { timeout: LLM_TIMEOUT_MS });
  return normalizeDescription(raw, name);
}

async function main(): Promise<void> {
  const { limit, resume, force } = parseArgs();
  const progress = readProgress(resume);
  const completed = new Set(progress.successfulIds);
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const client = createClient({ url: databasePath === ":memory:" ? "file::memory:" : `file:${databasePath}` });
  const db = drizzle(client);
  let success = 0; let failed = 0; let skipped = 0;
  try {
    const rows = await db.select({ entityId: organizations.entityId, name: organizations.name, description: organizations.description, officialDomain: organizations.websiteUrl }).from(organizations).all() as unknown as Candidate[];
    const pending = rows.filter((organization) => {
      const length = organization.description?.trim().length || 0;
      if (!force && length >= MIN_DESCRIPTION_LENGTH && completed.has(organization.entityId)) { skipped += 1; console.log(`[跳过] 机构 ${organization.name}: 原因 (已完成且简介长度 ${length})`); return false; }
      if (!force && length >= MIN_DESCRIPTION_LENGTH) { skipped += 1; console.log(`[跳过] 机构 ${organization.name}: 原因 (已有简介且长度 ${length})`); return false; }
      return true;
    }).slice(0, limit);
    const total = pending.length;
    for (const [index, organization] of pending.entries()) {
      const position = index + 1;
      try {
        const result = await scrapeOrganization(organization.name, normalizeDomain(organization.officialDomain));
        console.log(`[抓取] 机构 ${organization.name}: 来源 (${result.source.kind}: ${result.source.url})`);
        console.log(`[文本] 机构 ${organization.name}: 提取字符数 (${result.text.length})`);
        let description: string;
        try { description = await generateDescription(organization.name, result.text); }
        catch (error) { console.warn(`[LLM] ${organization.name}: 生成失败，保留抓取文本 (${error instanceof Error ? error.message : String(error)})`); description = normalizeDescription(`${RAW_TEXT_PREFIX}${result.text}`, organization.name); }
        const now = new Date().toISOString();
        await db.update(organizations).set({ description, summary: description, updatedAt: now }).where(eq(organizations.entityId, organization.entityId)).run();
        completed.add(organization.entityId); progress.successfulIds = [...completed]; saveProgress(progress); success += 1;
        console.log(`[${position}/${total}] 处理完成: ${organization.name}`);
      } catch (error) { failed += 1; console.error(`[${position}/${total}] 失败: ${organization.name} -> ${error instanceof Error ? error.message : String(error)}`); saveProgress(progress); }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, REQUEST_DELAY_MS));
    }
  } finally { client.close(); }
  console.log(`\n完成：成功 ${success}，失败 ${failed}，跳过 ${skipped}`);
}

main().catch((error) => { console.error("数据丰富脚本失败:", error instanceof Error ? error.message : error); process.exitCode = 1; });
