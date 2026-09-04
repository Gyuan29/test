#!/usr/bin/env npx tsx
/** Retry failed organization-name validations from the manual audit sample. */
import { constants } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createClient, type Client, type InStatement } from "@libsql/client";
import pLimit from "p-limit";
import { chatCompletion, LLM_MODEL_NAME } from "../../lib/llm-client";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DB_PATH = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(ROOT, ".local", "d1.sqlite");
const DB_URL = DB_PATH === ":memory:" ? "file::memory:" : DB_PATH.startsWith("file:") ? DB_PATH : `file:${DB_PATH}`;
const DB_FILE_PATH = DB_PATH.startsWith("file:") ? DB_PATH.slice(5) : DB_PATH;
const AUDIT_PATH = process.env.MANUAL_AUDIT_PATH?.trim() || resolve(ROOT, "data", "manual_audit_sample.json");
const VALID_NAMES_PATH = process.env.VALID_NAMES_PATH?.trim() || resolve(ROOT, "data", "valid_names.json");
const LLM_CONCURRENCY = Math.min(3, Math.max(1, Number(process.env.NAME_CLEAN_LLM_CONCURRENCY) || 2));
const TIMEOUT = Number(process.env.LLM_TIMEOUT_MS) || 120_000;
const MODEL = process.env.CLEAN_ORG_MODEL_NAME?.trim() || LLM_MODEL_NAME;
const REQUIRED_COLUMNS = ["cleaning_status", "audit_note", "retry_count"];

const BLOCKED_BRAND_NAMES = new Set(["apple", "microsoft", "yahoo", "google", "amazon", "meta", "facebook", "stack overflow", "鐧惧害", "鐧惧害缁忛獙"]);
const SYSTEM_PROMPT = [
  "You are a strict organization-name validation API.",
  "Return ONLY JSON: {\"status\":\"VALID\"|\"CORRECTED\"|\"INVALID\",\"name\":string,\"reason\":string}.",
  "If description, summary, events, and URLs are insufficient to determine the real entity, OR the current name is a generic phrase rather than a specific entity, return INVALID.",
  "Never guess or associate an unknown phrase with a famous company, brand, product, or unrelated organization.",
  "For CORRECTED, extract only a name explicitly supported by the supplied context; otherwise return INVALID.",
].join(" ");

type AuditEntry = string | { name?: unknown };
type AuditFile = { failed_network_errors?: unknown };
type ValidFile = { valid_institutions?: unknown };
type EventContext = { title: string; url: string };
type Organization = { id: string; slug: string; name: string; description: string; summary: string; originalName: string; events: EventContext[] };
type Status = "VALID" | "CORRECTED" | "INVALID";
type Result = { organization: Organization; status: "valid" | "corrected" | "invalid_name" | "needs_retry"; note: string; newName?: string; error?: string };

const asString = (value: unknown): string => typeof value === "string" ? value : value == null ? "" : String(value);
const clean = (value: string): string => value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
const normalize = (value: string): string => clean(value).toLocaleLowerCase();

function parseArgs(): boolean {
  let dryRun = process.argv.includes("--dry-run") || process.env.npm_config_dry_run === "true" || process.env.npm_config_dryRun === "true";
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === "--" || !arg) continue;
    if (arg === "--dry-run" || arg === "--dryRun") { dryRun = true; continue; }
    if (arg === "--help" || arg === "-h") { console.log("Usage: node --import tsx scripts/maintenance/retry-failed-names.ts [--dry-run]"); process.exit(0); }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return dryRun;
}

async function readAuditNames(): Promise<string[]> {
  const audit = JSON.parse(await readFile(AUDIT_PATH, "utf8")) as AuditFile;
  if (!Array.isArray(audit.failed_network_errors)) throw new Error("failed_network_errors must be an array");
  return [...new Set((audit.failed_network_errors as AuditEntry[]).map((entry) => clean(typeof entry === "string" ? entry : asString(entry.name))).filter(Boolean))];
}

async function readValidNames(): Promise<string[]> {
  try {
    const valid = JSON.parse(await readFile(VALID_NAMES_PATH, "utf8")) as ValidFile;
    if (!Array.isArray(valid.valid_institutions)) return [];
    return [...new Set((valid.valid_institutions as AuditEntry[]).map((entry) => clean(typeof entry === "string" ? entry : asString(entry.name))).filter(Boolean))];
  } catch {
    console.warn(`[retry-failed-names] valid_names.json not available: ${VALID_NAMES_PATH}`);
    return [];
  }
}

async function readOrganizations(client: Client): Promise<Organization[]> {
  const result = await client.execute("SELECT entity_id, slug, name, coalesce(description, '') AS description, coalesce(summary, '') AS summary, coalesce(original_name, '') AS original_name FROM organizations ORDER BY entity_id");
  const rows = result.rows as unknown as Record<string, unknown>[];
  const organizations = rows.map((row) => ({ id: asString(row.entity_id), slug: asString(row.slug), name: clean(asString(row.name)), description: clean(asString(row.description)), summary: clean(asString(row.summary)), originalName: clean(asString(row.original_name)), events: [] }));
  if (!organizations.length) return organizations;
  const events = await client.execute({ sql: `SELECT organization_id, title, source_url FROM events WHERE organization_id IN (${organizations.map(() => "?").join(",")}) ORDER BY created_at DESC`, args: organizations.map((organization) => organization.id) });
  const byId = new Map<string, EventContext[]>();
  for (const row of events.rows as unknown as Record<string, unknown>[]) {
    const id = asString(row.organization_id); const list = byId.get(id) || [];
    if (list.length < 10) list.push({ title: clean(asString(row.title)), url: clean(asString(row.source_url)) });
    byId.set(id, list);
  }
  return organizations.map((organization) => ({ ...organization, events: byId.get(organization.id) || [] }));
}

async function ensureSchema(client: Client, dryRun: boolean): Promise<void> {
  const result = await client.execute("PRAGMA table_info(organizations)");
  const columns = new Set((result.rows as unknown as Record<string, unknown>[]).map((row) => asString(row.name)));
  const definitions: Record<string, string> = {
    cleaning_status: "ALTER TABLE organizations ADD COLUMN cleaning_status TEXT NOT NULL DEFAULT 'unreviewed'",
    audit_note: "ALTER TABLE organizations ADD COLUMN audit_note TEXT",
    retry_count: "ALTER TABLE organizations ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0",
  };
  const missing = REQUIRED_COLUMNS.filter((column) => !columns.has(column));
  if (!missing.length) return;
  for (const column of missing) console.log(`[retry-failed-names] ${dryRun ? "WOULD EXECUTE" : "EXECUTE"} ${definitions[column]};`);
  if (dryRun) return;
  await client.execute("BEGIN");
  try { for (const column of missing) await client.execute(definitions[column]); await client.execute("COMMIT"); }
  catch (error) { await client.execute("ROLLBACK"); throw error; }
}

function match(organizations: Organization[], name: string): Organization | undefined {
  const exact = organizations.filter((organization) => [organization.name, organization.originalName].includes(name));
  if (exact.length === 1) return exact[0];
  const normalized = organizations.filter((organization) => [organization.name, organization.originalName].some((value) => normalize(value) === normalize(name)));
  return normalized.length === 1 ? normalized[0] : undefined;
}

function supportedCorrection(organization: Organization, candidate: string): boolean {
  if (BLOCKED_BRAND_NAMES.has(candidate.trim().toLocaleLowerCase())) return false;
  const compact = (value: string): string => value.toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\u4e00-\u9fff]/gu, "");
  const corrected = compact(candidate); const current = compact(organization.name); const slug = compact(organization.slug);
  if (corrected.length < 2 || current.length < 2) return false;
  const longestCommonSubstring = (left: string, right: string): number => { let best = 0; const table = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1)); for (let i = 1; i <= left.length; i += 1) for (let j = 1; j <= right.length; j += 1) if (left[i - 1] === right[j - 1]) { table[i][j] = table[i - 1][j - 1] + 1; best = Math.max(best, table[i][j]); } return best; };
  const overlap = Math.max(longestCommonSubstring(corrected, current), longestCommonSubstring(corrected, slug));
  if (overlap < 2 || overlap / Math.max(1, Math.min(corrected.length, current.length)) < 0.25) return false;
  const haystack = [organization.name, organization.slug, organization.description, organization.summary, ...organization.events.flatMap((event) => [event.title, event.url])].join(" ").toLocaleLowerCase();
  return haystack.includes(candidate.toLocaleLowerCase());
}

function parseSuggestion(raw: string): { status: Status; name: string; reason: string } {
  const parsed = JSON.parse(raw.trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "")) as Record<string, unknown>;
  const status = parsed.status; if (status !== "VALID" && status !== "CORRECTED" && status !== "INVALID") throw new Error("invalid LLM status");
  const name = clean(asString(parsed.name)); const reason = clean(asString(parsed.reason));
  if (status === "CORRECTED" && (name.length < 2 || name.length > 200)) throw new Error("invalid corrected name length");
  return { status, name, reason };
}

function errorCategory(error: unknown): "api_timeout" | "network_error" | "llm_parse_failed" {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return "api_timeout";
  if (error instanceof TypeError || /network|ECONN|ENOTFOUND|fetch failed|HTTP 5\d\d/i.test(message)) return "network_error";
  return "llm_parse_failed";
}

async function retry(organization: Organization): Promise<Result> {
  const context = JSON.stringify({ current_name: organization.name, slug: organization.slug, description: organization.description, summary: organization.summary, events: organization.events }, null, 2);
  try {
    const raw = await chatCompletion(SYSTEM_PROMPT, context, { model: MODEL, timeout: TIMEOUT, jsonMode: true, max_tokens: 300, stream: true });
    const parsed = parseSuggestion(raw);
    if (parsed.status === "VALID") return { organization, status: "valid", note: parsed.reason || "LLM retry classified as VALID" };
    if (parsed.status === "INVALID") return { organization, status: "invalid_name", note: parsed.reason || "LLM retry classified as INVALID" };
    if (!supportedCorrection(organization, parsed.name)) return { organization, status: "invalid_name", note: "unsupported_correction: retry correction failed safety validation" };
    return { organization, status: "corrected", note: parsed.reason || `LLM retry suggested correction: ${parsed.name}`, newName: parsed.name };
  } catch (error) {
    const reason = errorCategory(error);
    return { organization, status: "needs_retry", note: reason, error: error instanceof Error ? error.message : String(error) };
  }
}

function backupPath(): string {
  if (DB_FILE_PATH === ":memory:") throw new Error("Cannot create a physical backup for an in-memory database");
  const now = new Date(); const part = (value: number): string => String(value).padStart(2, "0");
  return `${DB_FILE_PATH}.backup.${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}-${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}`;
}

async function confirm(count: number): Promise<boolean> {
  const readline = createInterface({ input, output });
  try { return (await readline.question(`将更新 ${count} 条机构记录。请输入 YES 确认: `)) === "YES"; }
  finally { readline.close(); }
}

async function main(): Promise<void> {
  const dryRun = parseArgs();
  const client: Client = createClient({ url: DB_URL });
  try {
    await ensureSchema(client, dryRun);
    if (!dryRun) {
      const backup = backupPath();
      await copyFile(DB_FILE_PATH, backup, constants.COPYFILE_FICLONE_FORCE).catch(() => copyFile(DB_FILE_PATH, backup));
      console.log(`[retry-failed-names] database backup created: ${backup}`);
    }
    const names = await readAuditNames();
    const validNames = await readValidNames();
    const organizations = await readOrganizations(client);
    const targets = [...new Map(names.map((name) => match(organizations, name)).filter((organization): organization is Organization => Boolean(organization)).map((organization) => [organization.id, organization])).values()];
    const unmatched = names.filter((name) => !match(organizations, name));
    console.log(`[retry-failed-names] targets=${targets.length} unmatched=${unmatched.length} concurrency=${LLM_CONCURRENCY} mode=${dryRun ? "DRY-RUN" : "LIVE"}`);
    for (const name of unmatched) console.warn(`[retry-failed-names] unmatched: ${name}`);
    const limiter = pLimit(LLM_CONCURRENCY);
    const results = await Promise.all(targets.map((organization) => limiter(() => retry(organization))));
    const retriedIds = new Set(results.map((result) => result.organization.id));
    const validTargets = [...new Map(validNames.map((name) => match(organizations, name)).filter((organization): organization is Organization => Boolean(organization)).filter((organization) => !retriedIds.has(organization.id)).map((organization) => [organization.id, organization])).values()];
    for (const result of results) {
      console.log(`[retry-failed-names] ${result.organization.id} ${result.organization.name} -> ${result.status}${result.newName ? ` (${result.newName})` : ""}; ${result.note}`);
      if (dryRun) console.log(`[retry-failed-names] SQL: UPDATE organizations SET cleaning_status = ?, audit_note = ?, retry_count = retry_count + 1, updated_at = ? WHERE entity_id = ?; args=[${JSON.stringify(result.status)}, ${JSON.stringify(result.newName ? `${result.note}; suggested_name=${result.newName}` : result.note)}, <now>, ${JSON.stringify(result.organization.id)}]`);
    }
    for (const organization of validTargets) {
      console.log(`[retry-failed-names] ${dryRun ? "WOULD UPDATE" : "UPDATE"} ${organization.id} ${organization.name} -> valid_confirmed`);
      if (dryRun) console.log(`[retry-failed-names] SQL: UPDATE organizations SET cleaning_status = ?, audit_note = ?, updated_at = ? WHERE entity_id = ?; args=[\"valid_confirmed\", \"confirmed by valid_names.json\", <now>, ${JSON.stringify(organization.id)}]`);
    }
    const updateCount = results.length + validTargets.length;
    if (dryRun || updateCount === 0) return;
    if (!(await confirm(updateCount))) { console.log("Confirmation failed; no database changes made."); return; }
    const timestamp = new Date().toISOString();
    const statements: InStatement[] = [
      ...results.map((result) => ({ sql: "UPDATE organizations SET cleaning_status = ?, audit_note = ?, retry_count = retry_count + 1, updated_at = ? WHERE entity_id = ?", args: [result.status, result.newName ? `${result.note}; suggested_name=${result.newName}` : result.note, timestamp, result.organization.id] })),
      ...validTargets.map((organization) => ({ sql: "UPDATE organizations SET cleaning_status = ?, audit_note = ?, updated_at = ? WHERE entity_id = ?", args: ["valid_confirmed", "confirmed by valid_names.json", timestamp, organization.id] })),
    ];
    await client.execute("BEGIN");
    try { await client.batch(statements, "write"); await client.execute("COMMIT"); }
    catch (error) { await client.execute("ROLLBACK"); throw error; }
    console.log(`[retry-failed-names] committed ${statements.length} update(s)`);
  } finally { client.close(); }
}

main().catch((error: unknown) => { console.error(`[retry-failed-names] failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
