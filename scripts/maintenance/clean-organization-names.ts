#!/usr/bin/env npx tsx
/** Full-dataset LLM-assisted organization-name validation. */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { constants, mkdirSync } from "node:fs";
import { copyFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";
import pLimit from "p-limit";
import { chatCompletion, LLM_MODEL_NAME } from "../../lib/llm-client";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DB_PATH = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(ROOT, ".local", "d1.sqlite");
const DB_URL = DB_PATH === ":memory:" ? "file::memory:" : DB_PATH.startsWith("file:") ? DB_PATH : `file:${DB_PATH}`;
const DATA_DIR = resolve(ROOT, "data");
const CONCURRENCY = Math.max(1, Number(process.env.NAME_CLEAN_WORK_CONCURRENCY) || 3);
const LLM_CONCURRENCY = Math.min(3, Math.max(1, Number(process.env.NAME_CLEAN_LLM_CONCURRENCY) || 2));
const llmLimiter = pLimit(LLM_CONCURRENCY);
const TIMEOUT = Number(process.env.LLM_TIMEOUT_MS) || 120_000;
// Name validation benefits from a stronger reasoning model than page summarization.
// Keep the existing model as a compatibility fallback when no dedicated model is configured.
const CLEAN_ORG_MODEL_NAME = process.env.CLEAN_ORG_MODEL_NAME?.trim() || LLM_MODEL_NAME;
const MARKER_PATTERN = /(\u7684|\u4e86|\u8fdb\u4e00\u6b65|\u8d77\u6e90\u4e8e|\u8dfa\u8eab|\u843d\u5b9e|\u6218\u7565\u5e03\u5c40|\u5e73\u53f0|\u603b\u90e8|\u7814\u53d1\u4e2d\u5fc3)/u;
const ENGLISH_ENTITY = /^[A-Za-z][A-Za-z\s\-']{2,39}$/u;
const ENTITY_SUFFIX = /\b(University|Institute|Organization|Foundation|Association|Center|Centre|Lab|Laboratory|College|Academy|Authority|Department|Museum|Hospital|School|Council|Society|Federation|Agency|Corporation|Company)\b/i;
const BLOCKED_BRAND_NAMES = new Set(["apple", "microsoft", "yahoo", "google", "amazon", "meta", "facebook", "stack overflow", "百度", "百度经验"]);
const SYSTEM_PROMPT = [
  "You are a strict organization-name validation API.",
  "Return ONLY JSON: {\"status\":\"VALID\"|\"CORRECTED\"|\"INVALID\",\"name\":string,\"reason\":string}.",
  "If description, summary, events, and URLs are insufficient to determine the real entity, OR the current name is a generic phrase rather than a specific entity, return INVALID.",
  "Never guess. Never associate an unknown phrase with a famous company, brand, product, or unrelated organization. Do not return Microsoft, Yahoo, Stack Overflow, or any other invented name unless that exact entity is explicitly supported by the context.",
  "If the current name is a generic descriptive phrase, the corrected name must be directly related to that phrase and the current organization; do not copy an unrelated company or entity merely because it appears in a news snippet.",
  "If the current name contains University, Institute, Organization, Foundation, Association, Center, Centre, Lab, Laboratory, College, Academy, or another clear institution suffix and looks like a reasonable proper name, return VALID.",
  "For CORRECTED, extract only a name explicitly supported by the supplied context; otherwise return INVALID.",
].join(" ");

type EventContext = { title: string; url: string };
type Organization = { id: string; slug: string; name: string; description: string; summary: string; events: EventContext[] };
type Status = "VALID" | "CORRECTED" | "INVALID";
type Suggestion = { organization: Organization; status: Status; name: string; reason: string; error?: string; shortCircuit?: boolean };
type Progress = { taskId: string; total: number; started: number; processed: number; corrected: number; valid: number; invalid: number; failed: number; skipped: number; status: "running" | "completed" | "failed"; lastUpdated: string };

const asString = (value: unknown): string => typeof value === "string" ? value : value == null ? "" : String(value);
const clean = (value: string): string => value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
const safeTaskId = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96) || "default";
const progressPath = (taskId: string): string => resolve(DATA_DIR, `name_clean_progress_${safeTaskId(taskId)}.json`);

let progressWriteQueue: Promise<void> = Promise.resolve();

const PROGRESS_RENAME_RETRIES = 3;
const PROGRESS_RENAME_RETRY_DELAY_MS = 100;

function isWindowsLockError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EBUSY";
}

async function replaceProgressFile(temporary: string, path: string): Promise<void> {
  let renameError: unknown;

  for (let attempt = 0; attempt < PROGRESS_RENAME_RETRIES; attempt += 1) {
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      renameError = error;
      if (!isWindowsLockError(error) || attempt === PROGRESS_RENAME_RETRIES - 1) break;
      await new Promise((resolve) => setTimeout(resolve, PROGRESS_RENAME_RETRY_DELAY_MS * (attempt + 1)));
    }
  }

  if (!isWindowsLockError(renameError)) throw renameError;

  // Windows may reject replacing an existing/locked destination with rename.
  try {
    await copyFile(temporary, path, constants.COPYFILE_FICLONE_FORCE);
  } catch {
    // Some filesystems do not support forced clone; a normal overwrite is the fallback.
    await copyFile(temporary, path);
  }
  await unlink(temporary).catch(() => undefined);
}

function saveProgress(progress: Progress, path: string): Promise<void> {
  const snapshot = { ...progress };
  const operation = progressWriteQueue.then(async () => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
    const body = `${JSON.stringify({ ...snapshot, lastUpdated: new Date().toISOString() }, null, 2)}\n`;
    try { await writeFile(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 }); await replaceProgressFile(temporary, path); }
    catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  });
  progressWriteQueue = operation.catch(() => undefined);
  return operation;
}

async function readOrganizations(client: Client, allMode: boolean, limit?: number): Promise<Organization[]> {
  const result = await client.execute("SELECT entity_id, slug, name, description, summary FROM organizations ORDER BY entity_id");
  const sourceRows = result.rows as unknown as Record<string, unknown>[];
  const scopedRows = allMode ? sourceRows : sourceRows.filter((row) => { const name = clean(asString(row.name)); return name.length > 20 || MARKER_PATTERN.test(name); });
  const rows = limit === undefined ? scopedRows : scopedRows.slice(0, limit);
  const eventRows = rows.length ? await client.execute({ sql: `SELECT organization_id, title, source_url FROM events WHERE organization_id IN (${rows.map(() => "?").join(",")}) ORDER BY created_at DESC`, args: rows.map((row) => asString(row.entity_id)) }) : { rows: [] };
  const byOrganization = new Map<string, EventContext[]>();
  for (const row of eventRows.rows as unknown as Record<string, unknown>[]) { const id = asString(row.organization_id); const events = byOrganization.get(id) || []; if (events.length < 10) events.push({ title: clean(asString(row.title)), url: clean(asString(row.source_url)) }); byOrganization.set(id, events); }
  const organizations = rows.map((row) => ({ id: asString(row.entity_id), slug: asString(row.slug), name: clean(asString(row.name)), description: clean(asString(row.description)), summary: clean(asString(row.summary)), events: byOrganization.get(asString(row.entity_id)) || [] }));
  return organizations;
}

function definitelyValid(name: string): boolean { return ENGLISH_ENTITY.test(name) || ENTITY_SUFFIX.test(name); }
function errorCategory(error: unknown): "api_timeout" | "network_error" | "llm_parse_failed" {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return "api_timeout";
  if (error instanceof TypeError) return "network_error";
  if (/network|ECONN|ENOTFOUND|fetch failed|HTTP 5\d\d/i.test(message)) return "network_error";
  if (/empty completion|empty response|no response/i.test(message)) return "network_error";
  return "llm_parse_failed";
}
function supportedCorrection(organization: Organization, candidate: string): boolean {
  if (BLOCKED_BRAND_NAMES.has(candidate.trim().toLocaleLowerCase())) return false;
  const compact = (value: string): string => value.toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\u4e00-\u9fff]/gu, "");
  const corrected = compact(candidate); const current = compact(organization.name); const slug = compact(organization.slug);
  if (corrected.length < 2 || current.length < 2) return false;
  const longestCommonSubstring = (left: string, right: string): number => { let best = 0; const table = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1)); for (let i = 1; i <= left.length; i += 1) for (let j = 1; j <= right.length; j += 1) { if (left[i - 1] === right[j - 1]) { table[i][j] = table[i - 1][j - 1] + 1; if (table[i][j] > best) best = table[i][j]; } } return best; };
  const overlap = Math.max(longestCommonSubstring(corrected, current), longestCommonSubstring(corrected, slug));
  const referenceLength = Math.min(corrected.length, current.length);
  if (overlap < 2 || overlap / Math.max(1, referenceLength) < 0.25) return false;
  const haystack = [organization.name, organization.slug, organization.description, organization.summary, ...organization.events.flatMap((event) => [event.title, event.url])].join(" ").toLocaleLowerCase();
  return haystack.includes(candidate.toLocaleLowerCase());
}
function parseSuggestion(raw: string): Pick<Suggestion, "status" | "name" | "reason"> {
  const parsed = JSON.parse(raw.trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "")) as Record<string, unknown>;
  const status = parsed.status; if (status !== "VALID" && status !== "CORRECTED" && status !== "INVALID") throw new Error("invalid LLM status");
  const name = clean(asString(parsed.name)); const reason = clean(asString(parsed.reason));
  if (status === "CORRECTED" && (name.length < 2 || name.length > 200)) throw new Error("invalid corrected name length");
  // INVALID responses may echo the original name; keep it for audit output and never write it.
  return { status, name, reason };
}

async function suggest(organization: Organization, position: number, total: number): Promise<Suggestion> {
  if (definitelyValid(organization.name)) { console.log(`[进度 ${position}/${total}] ${organization.name} -> VALID (short-circuit)`); return { organization, status: "VALID", name: "", reason: "clear institution-style name", shortCircuit: true }; }
  console.log(`[进度 ${position}/${total}] 正在处理: ${organization.name}...`);
  const context = JSON.stringify({ current_name: organization.name, slug: organization.slug, description: organization.description, summary: organization.summary, events: organization.events }, null, 2);
  if (organization.name.includes("450") && organization.name.includes("\u5236\u9020\u4e1a")) console.log(`[debug-context] ${context}`);
  let rawResponse = "";
  try { rawResponse = await llmLimiter(async () => chatCompletion(SYSTEM_PROMPT, context, { model: CLEAN_ORG_MODEL_NAME, timeout: TIMEOUT, jsonMode: true, max_tokens: 300, stream: true })); const parsed = parseSuggestion(rawResponse); if (parsed.status === "CORRECTED" && !supportedCorrection(organization, parsed.name)) { console.log(`[进度 ${position}/${total}] 拒绝不受支持的纠正: ${organization.name} -> ${parsed.name}`); return { organization, status: "INVALID", name: "", reason: "unsupported_correction" }; } console.log(`[进度 ${position}/${total}] 完成: ${organization.name} -> ${parsed.status}${parsed.name ? ` (${parsed.name})` : ""}`); return { organization, ...parsed }; }
  catch (error) { const category = errorCategory(error); console.log(`[进度 ${position}/${total}] 失败: ${organization.name} (${category})`); if (category === "llm_parse_failed") console.log(`[llm-raw:${organization.name}] ${rawResponse.slice(0, 500) || "<empty response>"}`); return { organization, status: "INVALID", name: "", reason: category, error: error instanceof Error ? error.message : String(error) }; }
}

async function confirm(count: number): Promise<boolean> { const readline = createInterface({ input, output }); try { const answer = await readline.question(`将更新 ${count} 条机构名称。请输入精确的 YES（区分大小写）继续: `); if (answer !== "YES") { console.log("确认失败，未修改数据库。"); return false; } return true; } finally { readline.close(); } }

async function main(): Promise<void> {
  console.warn("⚠️ 运行期间请勿使用任何文本编辑器打开进度 JSON 文件，否则可能导致 Windows 文件锁 (EPERM) 错误。");
  const directArgv = process.argv.slice(2); let npmArgv: string[] = [];
  try { const parsed = JSON.parse(process.env.npm_config_argv || "{}"); if (Array.isArray(parsed.original)) npmArgv = parsed.original.filter((value: unknown) => typeof value === "string" && value.startsWith("--")); } catch { /* Ignore malformed npm metadata. */ }
  const argv = [...directArgv, ...npmArgv.filter((arg) => !directArgv.includes(arg))]; let dryRun = false; let allMode = true; let taskId = `name_clean_${Date.now()}`; let limit: number | undefined; const unknown: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]; if (arg === "--") continue;
    if (arg === "--dry-run" || arg === "--dryRun") { dryRun = true; continue; }
    if (arg === "--all") { allMode = true; continue; }
    if (arg === "--suspects-only") { allMode = false; continue; }
    const equals = arg.indexOf("="); const key = equals >= 0 ? arg.slice(0, equals) : arg; let value = equals >= 0 ? arg.slice(equals + 1) : undefined;
    if (key === "--task-id" || key === "--limit") {
      if (value === undefined) { index += 1; value = argv[index]; }
      if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
      if (key === "--task-id") taskId = value;
      else { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 0) throw new Error("--limit must be a non-negative integer"); limit = parsed; }
      continue;
    }
    unknown.push(arg);
  }
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
  // npm may expose script options as npm_config_* instead of forwarding argv.
  if (process.env.npm_config_dry_run === "true" || process.env.npm_config_dryRun === "true") dryRun = true;
  if (process.env.npm_config_task_id && taskId.startsWith("name_clean_")) taskId = process.env.npm_config_task_id;
  if (limit === undefined && process.env.npm_config_limit !== undefined) {
    const parsed = Number(process.env.npm_config_limit); if (!Number.isInteger(parsed) || parsed < 0) throw new Error("npm_config_limit must be a non-negative integer"); limit = parsed;
  }
  console.log(`[clean-names] raw argv=${JSON.stringify(directArgv)} npm argv=${JSON.stringify(npmArgv)} npm_config_limit=${process.env.npm_config_limit || "none"}`);
  console.log(`[clean-names] parsed args: all=${allMode} dryRun=${dryRun} limit=${limit ?? "none"} taskId=${taskId}`);
  if (DB_PATH !== ":memory:" && !DB_PATH.startsWith("file:")) mkdirSync(dirname(DB_PATH), { recursive: true });
  const client = createClient({ url: DB_URL }); const path = progressPath(taskId);
  try {
    const organizations = await readOrganizations(client, allMode, limit); let endpointHost = "unknown"; try { endpointHost = new URL(process.env.LLM_BASE_URL || "").host || endpointHost; } catch { /* Keep endpoint redacted/unknown. */ } console.log(`[clean-names] llm endpoint=${endpointHost} model=${CLEAN_ORG_MODEL_NAME} scope=${allMode ? "all" : "suspects-only"} total=${organizations.length}`); const progress: Progress = { taskId, total: organizations.length, started: 0, processed: 0, corrected: 0, valid: 0, invalid: 0, failed: 0, skipped: 0, status: "running", lastUpdated: new Date().toISOString() }; await saveProgress(progress, path);
    const limiter = pLimit(CONCURRENCY); const suggestions: Suggestion[] = [];
    const tasks = organizations.map((organization) => limiter(async () => { const position = progress.started + 1; progress.started = position; await saveProgress(progress, path); return suggest(organization, position, organizations.length); }));
    for (const suggestion of await Promise.all(tasks)) { suggestions.push(suggestion); progress.processed += 1; if (suggestion.status === "CORRECTED") progress.corrected += 1; if (suggestion.status === "VALID") progress.valid += 1; if (suggestion.status === "INVALID") progress.invalid += 1; if (suggestion.error) progress.failed += 1; if (suggestion.shortCircuit) progress.skipped += 1; await saveProgress(progress, path); }
    const corrections = suggestions.filter((item) => item.status === "CORRECTED");
    if (dryRun) { progress.status = "completed"; await saveProgress(progress, path); console.log(`DRY-RUN complete: ${organizations.length} checked, ${corrections.length} correction(s) suggested; no writes executed.`); return; }
    if (!(await confirm(corrections.length))) return;
    await client.execute("BEGIN");
    try { for (const item of corrections) await client.execute({ sql: "UPDATE organizations SET name = ?, updated_at = ? WHERE entity_id = ? AND name = ?", args: [item.name, new Date().toISOString(), item.organization.id, item.organization.name] }); await client.execute("COMMIT"); }
    catch (error) { await client.execute("ROLLBACK"); throw error; }
    progress.status = "completed"; await saveProgress(progress, path); console.log(`Name cleaning complete: ${corrections.length} organization name(s) updated.`);
  } finally { client.close(); }
}
main().catch((error: unknown) => { console.error(`[clean-names] failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
