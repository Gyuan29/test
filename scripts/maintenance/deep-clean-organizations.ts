#!/usr/bin/env npx tsx
/** Deep-clean organizations whose website or descriptive text is disguised page content. */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";
import pLimit from "p-limit";
import { chatCompletion, LLM_MODEL_NAME } from "../../lib/llm-client";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DB_PATH = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(ROOT, ".local", "d1.sqlite");
const DB_URL = DB_PATH === ":memory:" ? "file::memory:" : DB_PATH.startsWith("file:") ? DB_PATH : `file:${DB_PATH}`;
const LLM_CONCURRENCY = 3;
const LLM_TIMEOUT_MS = 120_000;

type Row = Record<string, unknown>;
type DomainColumn = "website_url" | "official_domain";
type OrganizationRow = { entity_id: unknown; name: unknown; website: unknown; description: unknown; summary: unknown; event_count: unknown };
type Candidate = {
  id: string; name: string; website: string | null; description: string | null; summary: string | null; eventCount: number;
  websiteRules: string[]; summaryClearRules: string[]; summarySource: string | null; summaryOriginalLength: number; deleteOrganization: boolean;
};
type SummaryResult = { candidate: Candidate; summary: string | null; error?: string };

const INVALID_PATH_SEGMENTS = new Set(["blog", "article", "post", "video", "login", "register", "shop", "forum"]);
const SOCIAL_OR_UGC_DOMAINS = new Set(["blogspot.com", "wordpress.com", "medium.com", "youtube.com", "tiktok.com", "facebook.com", "twitter.com", "linkedin.com", "weibo.com"]);
const LOGIN_REGISTER_PATTERN = /登录|注册/;
const SUMMARY_KEYWORDS: Array<[RegExp, string]> = [
  [/版权所有|copyright/i, "通用版权声明"], [/ICP备案|icp\s*(?:备案|beian)/i, "ICP备案信息"], [LOGIN_REGISTER_PATTERN, "登录/注册提示"],
  [/首页|联系我们|广告/, "网页导航或广告词"], [/cookie|隐私政策/i, "Cookie/隐私政策"],
];
const CHINESE_STOPWORDS = ["的", "了", "是", "在", "和", "与", "及", "为", "被", "或"];
const SUMMARY_SYSTEM_PROMPT = "请将以下机构简介总结为200-500字的中文核心介绍，保留机构性质、核心业务、研究领域和重要成就，去除冗余的网页导航、版权声明和广告信息。输出纯文本，不要Markdown格式。";

function asString(value: unknown): string { return typeof value === "string" ? value : value == null ? "" : String(value); }
function parseEventCount(value: unknown): number { const count = Number(value); return Number.isFinite(count) && count >= 0 ? count : 0; }
function hostnameIsPlatform(hostname: string): string | null {
  for (const domain of SOCIAL_OR_UGC_DOMAINS) if (hostname === domain || hostname.endsWith(`.${domain}`)) return domain;
  return null;
}
function websiteRules(value: string | null): string[] {
  if (!value?.trim()) return [];
  let url: URL;
  try { url = new URL(value.trim().includes("://") ? value.trim() : `https://${value.trim()}`); } catch { return ["URL 格式无效"]; }
  const hits: string[] = []; const platform = hostnameIsPlatform(url.hostname.toLowerCase());
  if (platform) hits.push(`UGC/社交平台域名 ${platform}`);
  const segments = url.pathname.split("/").map((part) => part.trim().toLowerCase()).filter(Boolean);
  const pathHit = segments.find((segment) => INVALID_PATH_SEGMENTS.has(segment));
  if (pathHit) hits.push(`路径特征 /${pathHit}/`);
  // A bare /news page can be a legitimate institutional news section.
  if (segments[0] === "news" && segments.length > 1) hits.push("路径特征 /news/");
  if (segments.length > 5) hits.push("路径层级超过 5 级");
  return [...new Set(hits)];
}
function stopwordRatio(text: string): number | null {
  const compact = text.replace(/\s+/g, ""); const chinese = [...compact].filter((char) => /[\u4e00-\u9fff]/u.test(char));
  if (chinese.length >= 20) return chinese.filter((char) => CHINESE_STOPWORDS.includes(char)).length / chinese.length;
  const words = compact.toLowerCase().match(/[a-z]+/g) ?? []; if (words.length < 10) return null;
  const stopwords = new Set(["the", "and", "of", "to", "in", "a", "an", "is", "are", "this", "that"]);
  return words.filter((word) => stopwords.has(word)).length / words.length;
}
function summaryRules(value: string | null, fieldName: "description" | "summary"): { clearRules: string[]; isLong: boolean } {
  const text = value?.trim() ?? ""; if (!text) return { clearRules: [], isLong: false };
  const length = [...text].length; const isLong = length > 2000; const clearRules: string[] = [];
  for (const [pattern, label] of SUMMARY_KEYWORDS) {
    if (!pattern.test(text)) continue;
    // Long pages are sent to the model so it can remove navigation/copyright noise;
    // login/register prompts remain a hard quality failure.
    if (!isLong || pattern === LOGIN_REGISTER_PATTERN) clearRules.push(`${fieldName} 含${label}`);
  }
  if (length < 20) clearRules.push(`${fieldName} 长度少于 20 字符`);
  const ratio = stopwordRatio(text); if (ratio !== null && ratio >= 0.45) clearRules.push(`${fieldName} 停用词比例 ${(ratio * 100).toFixed(0)}%`);
  return { clearRules, isLong };
}
async function domainColumn(client: Client): Promise<DomainColumn> {
  const result = await client.execute("PRAGMA table_info(organizations)"); const columns = new Set(result.rows.map((row) => String((row as Row).name)));
  if (columns.has("website_url")) return "website_url"; if (columns.has("official_domain")) return "official_domain";
  throw new Error("organizations table has neither website_url nor official_domain");
}
async function buildPlan(client: Client, domain: DomainColumn): Promise<Candidate[]> {
  const result = await client.execute({ sql: `SELECT o.entity_id, o.name, o.${domain} AS website, o.description, o.summary,
      (SELECT COUNT(*) FROM events AS e WHERE e.organization_id = o.entity_id) AS event_count FROM organizations AS o`, args: [] });
  const candidates: Candidate[] = [];
  for (const row of result.rows as unknown as OrganizationRow[]) {
    const website = typeof row.website === "string" ? row.website : null; const description = typeof row.description === "string" ? row.description : null; const summary = typeof row.summary === "string" ? row.summary : null;
    const websiteHits = websiteRules(website); const descriptionRules = summaryRules(description, "description"); const summaryRulesForField = summaryRules(summary, "summary");
    const clearRules = [...descriptionRules.clearRules, ...summaryRulesForField.clearRules]; const longSources = [description, summary].filter((value): value is string => Boolean(value && [...value.trim()].length > 2000));
    const summarySource = longSources.sort((left, right) => [...right].length - [...left].length)[0] ?? null; const eventCount = parseEventCount(row.event_count); const deleteOrganization = websiteHits.length > 0 && eventCount === 0;
    if (websiteHits.length === 0 && clearRules.length === 0 && summarySource === null) continue;
    candidates.push({ id: asString(row.entity_id), name: asString(row.name), website, description, summary, eventCount, websiteRules: websiteHits, summaryClearRules: clearRules,
      summarySource: deleteOrganization || clearRules.length > 0 ? null : summarySource, summaryOriginalLength: summarySource ? [...summarySource].length : 0, deleteOrganization });
  }
  return candidates;
}
function printPlan(candidates: Candidate[], dryRun: boolean): void {
  const deletions = candidates.filter((item) => item.deleteOrganization).length; const websiteClears = candidates.filter((item) => item.websiteRules.length > 0 && !item.deleteOrganization).length;
  const summaryClears = candidates.filter((item) => item.summaryClearRules.length > 0 && !item.deleteOrganization).length; const summaries = candidates.filter((item) => item.summarySource !== null).length;
  console.log(`\n深度清洗预览 (${dryRun ? "DRY-RUN，只读" : "正式执行"})`); console.log("========================"); console.log(`待处理机构: ${candidates.length}`);
  console.log(`清空官网: ${websiteClears}; 清空简介: ${summaryClears}; LLM总结简介: ${summaries}; 删除零事件机构: ${deletions}`);
  if (candidates.length === 0) { console.log("没有命中伪装数据的机构。"); return; }
  for (const item of candidates) {
    if (item.summarySource !== null && dryRun) { console.log(`[Dry-Run] 将会总结机构 ${item.name || item.id} 的简介 (原始长度 ${item.summaryOriginalLength})`); continue; }
    const suffix = item.deleteOrganization ? "删除机构（假官网且零事件）" : [item.websiteRules.length > 0 ? `清空官网（命中 ${item.websiteRules.join(" / ")}）` : "", item.summaryClearRules.length > 0 ? `清空简介（命中 ${item.summaryClearRules.join(" / ")}）` : "", item.summarySource !== null ? `总结简介（原始长度 ${item.summaryOriginalLength}）` : ""].filter(Boolean).join("；");
    console.log(`[清洗] 机构 ${item.id} | ${item.name || "(无名称)"}: ${suffix}`);
  }
}
async function confirmWrites(count: number, summaryCount: number): Promise<boolean> {
  console.error(`\n警告：将处理 ${count} 个机构，数据库写入不可自动撤销。`); console.error(`将调用 LLM 总结 ${summaryCount} 个机构的简介。`);
  const readline = createInterface({ input, output }); try { const answer = await readline.question("请输入精确的 YES 以继续（区分大小写）："); if (answer !== "YES") { console.log("确认失败，已安全退出，未修改数据库。"); return false; } return true; } finally { readline.close(); }
}
function cleanLlmText(value: string): string { return value.replace(/^```(?:text|plaintext)?\s*/i, "").replace(/\s*```$/i, "").trim(); }
async function summarizeCandidate(candidate: Candidate): Promise<SummaryResult> {
  if (!candidate.summarySource) return { candidate, summary: null };
  try {
    const response = await chatCompletion(SUMMARY_SYSTEM_PROMPT, `机构名称：${candidate.name || "未知机构"}\n原始简介：\n${candidate.summarySource}`, { timeout: LLM_TIMEOUT_MS, model: LLM_MODEL_NAME, max_tokens: 1_000 });
    const summary = cleanLlmText(response); if (!summary) throw new Error("LLM 返回空总结");
    console.log(`[总结] 机构 ${candidate.name || candidate.id}: 原始长度 ${candidate.summaryOriginalLength} -> 总结后长度 ${[...summary].length}`); return { candidate, summary };
  } catch (error) { const message = error instanceof Error ? error.message : String(error); console.warn(`[警告] 机构 ${candidate.name || candidate.id} 总结失败，将 fallback 到清空简介: ${message}`); return { candidate, summary: null, error: message }; }
}
async function executePlan(client: Client, domain: DomainColumn, candidates: Candidate[], summaryResults: SummaryResult[]): Promise<void> {
  const summaries = new Map(summaryResults.map((result) => [result.candidate.id, result])); await client.execute("BEGIN");
  try {
    for (const item of candidates) {
      if (item.deleteOrganization) { await client.execute({ sql: "DELETE FROM events WHERE organization_id = ?", args: [item.id] }); await client.execute({ sql: "DELETE FROM organizations WHERE entity_id = ?", args: [item.id] }); continue; }
      if (item.websiteRules.length > 0) await client.execute({ sql: `UPDATE organizations SET ${domain} = NULL WHERE entity_id = ?`, args: [item.id] });
      if (item.summarySource !== null) { const result = summaries.get(item.id); if (result?.summary) await client.execute({ sql: "UPDATE organizations SET description = ?, summary = ? WHERE entity_id = ?", args: [result.summary, result.summary, item.id] }); else await client.execute({ sql: "UPDATE organizations SET description = NULL, summary = NULL WHERE entity_id = ?", args: [item.id] }); }
      else if (item.summaryClearRules.length > 0) await client.execute({ sql: "UPDATE organizations SET description = NULL, summary = NULL WHERE entity_id = ?", args: [item.id] });
    }
    await client.execute("COMMIT");
  } catch (error) { await client.execute("ROLLBACK"); throw error; }
}
async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run") || process.argv.includes("--dryRun") || process.env.npm_config_dry_run === "true" || process.env.npm_config_dryRun === "true";
  const unknown = process.argv.slice(2).filter((arg) => arg !== "--dry-run" && arg !== "--dryRun"); if (unknown.length > 0) throw new Error(`未知参数：${unknown.join(", ")}。用法：npm run maintenance:deep-clean -- [--dry-run]`);
  if (DB_PATH !== ":memory:" && !DB_PATH.startsWith("file:")) mkdirSync(dirname(DB_PATH), { recursive: true }); const client = createClient({ url: DB_URL });
  try {
    await client.execute("PRAGMA foreign_keys = ON"); const domain = await domainColumn(client); const candidates = await buildPlan(client, domain); printPlan(candidates, dryRun);
    if (dryRun) { console.log("\nDRY-RUN 完成：未调用 LLM，未执行任何 UPDATE 或 DELETE。"); return; }
    const summaryCandidates = candidates.filter((item) => item.summarySource !== null); if (candidates.length === 0 || !(await confirmWrites(candidates.length, summaryCandidates.length))) return;
    const limiter = pLimit(LLM_CONCURRENCY); const summaryResults = await Promise.all(summaryCandidates.map((candidate) => limiter(() => summarizeCandidate(candidate)))); await executePlan(client, domain, candidates, summaryResults);
    const failedSummaries = summaryResults.filter((result) => result.error).length; console.log(`\n深度清洗完成：已处理 ${candidates.length} 个机构；LLM总结失败并清空 ${failedSummaries} 个机构。`);
  } finally { client.close(); }
}
main().catch((error: unknown) => { console.error(`[deep-clean] failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
