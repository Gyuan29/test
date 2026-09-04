#!/usr/bin/env npx tsx
/** Synchronize generated audit JSON into organizations. Requires YES for writes. */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createClient, type Client, type InStatement } from "@libsql/client";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DB_PATH = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(ROOT, ".local", "d1.sqlite");
const DB_URL = DB_PATH === ":memory:" ? "file::memory:" : DB_PATH.startsWith("file:") ? DB_PATH : `file:${DB_PATH}`;
const VALID_PATH = resolve(ROOT, "data", "valid_names.json");
const AUDIT_PATH = resolve(ROOT, "data", "manual_audit_sample.json");
const REQUIRED_COLUMNS = ["cleaning_status", "audit_note", "retry_count"];
type Row = Record<string, unknown>;
type Organization = { id: string; name: string; originalName: string };
type Audit = { corrected?: unknown; rejected_hallucinations?: unknown; invalid_descriptive_texts?: unknown; failed_network_errors?: unknown };
type Correction = { old_name?: unknown; new_name?: unknown };
type Rejection = { name?: unknown; attempted_correction?: unknown };
type Update = { organization: Organization; status: string; note: string };
type Candidate = { status: string; note: string; priority: number };

const asString = (value: unknown): string => typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
const normalize = (value: string): string => value.toLocaleLowerCase().replace(/\s+/gu, " ").trim();
const parseArgs = (): boolean => {
  let dryRun = process.argv.includes("--dry-run") || process.env.npm_config_dry_run === "true" || process.env.npm_config_dryRun === "true";
  for (let index = 2; index < process.argv.length; index += 1) { const arg = process.argv[index]; if (arg === "--" || !arg) continue; if (arg === "--dry-run" || arg === "--dryRun") { dryRun = true; continue; } if (arg === "--help" || arg === "-h") { console.log("Usage: node --import tsx scripts/maintenance/sync-audit-to-db.ts [--dry-run]"); process.exit(0); } throw new Error(`Unknown argument: ${arg}`); }
  return dryRun;
};

async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }
async function readOrganizations(client: Client): Promise<Organization[]> { const result = await client.execute("SELECT entity_id, name, coalesce(original_name, '') AS original_name FROM organizations ORDER BY entity_id"); return (result.rows as unknown as Row[]).map((row) => ({ id: asString(row.entity_id), name: asString(row.name), originalName: asString(row.original_name) })); }
async function missingColumns(client: Client): Promise<string[]> { const result = await client.execute("PRAGMA table_info(organizations)"); const columns = new Set((result.rows as unknown as Row[]).map((row) => asString(row.name))); return REQUIRED_COLUMNS.filter((column) => !columns.has(column)); }

async function ensureSchema(client: Client, dryRun: boolean): Promise<void> {
  const definitions: Record<string, string> = { cleaning_status: "ALTER TABLE organizations ADD COLUMN cleaning_status TEXT NOT NULL DEFAULT 'unreviewed'", audit_note: "ALTER TABLE organizations ADD COLUMN audit_note TEXT", retry_count: "ALTER TABLE organizations ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0" };
  const missing = await missingColumns(client);
  for (const column of missing) console.log(`[sync-audit] ${dryRun ? "WOULD EXECUTE" : "EXECUTE"} ${definitions[column]};`);
  if (dryRun || !missing.length) return;
  await client.execute("BEGIN");
  try { for (const column of missing) await client.execute(definitions[column]); await client.execute("COMMIT"); } catch (error) { await client.execute("ROLLBACK"); throw error; }
}

function add(map: Map<string, Candidate[]>, name: string, candidate: Candidate): void { if (!name) return; const key = normalize(name); map.set(key, [...(map.get(key) || []), candidate]); }
function collect(audit: Audit, validNames: unknown): Map<string, Candidate[]> {
  const map = new Map<string, Candidate[]>();
  for (const entry of Array.isArray(audit.corrected) ? audit.corrected as Correction[] : []) { const oldName = asString(entry.old_name); const newName = asString(entry.new_name); const candidate = { status: "corrected", note: `log CORRECTED; old_name=${oldName}; new_name=${newName}`, priority: 5 }; add(map, oldName, candidate); add(map, newName, candidate); }
  for (const entry of Array.isArray(audit.rejected_hallucinations) ? audit.rejected_hallucinations as Rejection[] : []) { const name = asString(entry.name); add(map, name, { status: "rejected_hallucination", note: `log rejected hallucinated correction: ${asString(entry.attempted_correction)}`, priority: 4 }); }
  for (const name of Array.isArray(audit.invalid_descriptive_texts) ? audit.invalid_descriptive_texts : []) add(map, asString(name), { status: "invalid_name", note: "log INVALID: descriptive text is not an organization name", priority: 3 });
  for (const name of Array.isArray(audit.failed_network_errors) ? audit.failed_network_errors : []) add(map, asString(name), { status: "needs_retry", note: "log FAILED: network or timeout error", priority: 2 });
  for (const name of Array.isArray(validNames) ? validNames : []) add(map, asString(name), { status: "valid", note: "log VALID", priority: 1 });
  return map;
}

function match(organizations: Organization[], name: string): Organization[] { const exact = organizations.filter((organization) => organization.name === name || organization.originalName === name); if (exact.length) return exact; const normalized = normalize(name); return organizations.filter((organization) => normalize(organization.name) === normalized || normalize(organization.originalName) === normalized); }

async function confirm(count: number): Promise<boolean> { const readline = createInterface({ input, output }); try { return (await readline.question(`将更新 ${count} 条机构记录。请输入 YES 确认: `)) === "YES"; } finally { readline.close(); } }

async function main(): Promise<void> {
  const dryRun = parseArgs(); const validFile = await readJson<{ valid_institutions?: unknown }>(VALID_PATH); const audit = await readJson<Audit>(AUDIT_PATH); const client: Client = createClient({ url: DB_URL });
  try {
    await ensureSchema(client, dryRun); const organizations = await readOrganizations(client); const candidates = collect(audit, validFile.valid_institutions); const updates = new Map<string, Update>(); let unmatched = 0;
    for (const [name, values] of candidates) { const matches = match(organizations, name); if (!matches.length) { unmatched += 1; console.warn(`[sync-audit] unmatched: ${name}`); continue; } const selected = [...values].sort((left, right) => right.priority - left.priority)[0]; for (const organization of matches) { const previous = updates.get(organization.id); if (!previous || selected.status !== "valid" || previous.status === "valid") updates.set(organization.id, { organization, status: selected.status, note: previous && previous.note !== selected.note ? `${previous.note}; ${selected.note}` : selected.note }); } }
    const updatesList = [...updates.values()].sort((left, right) => left.organization.id.localeCompare(right.organization.id)); for (const update of updatesList) { console.log(`[sync-audit] ${dryRun ? "WOULD UPDATE" : "UPDATE"} ${update.organization.id} ${update.organization.name} -> ${update.status}; ${update.note}`); if (dryRun) console.log(`[sync-audit] SQL: UPDATE organizations SET cleaning_status = ?, audit_note = ?, updated_at = ? WHERE entity_id = ?; args=[${JSON.stringify(update.status)}, ${JSON.stringify(update.note)}, <now>, ${JSON.stringify(update.organization.id)}]`); }
    console.log(`[sync-audit] matched=${updatesList.length} unmatched_names=${unmatched} mode=${dryRun ? "DRY-RUN" : "LIVE"}`); if (dryRun || !updatesList.length) return; if (!(await confirm(updatesList.length))) { console.log("Confirmation failed; no database changes made."); return; }
    const timestamp = new Date().toISOString(); const statements: InStatement[] = updatesList.map((update) => ({ sql: "UPDATE organizations SET cleaning_status = ?, audit_note = ?, updated_at = ? WHERE entity_id = ?", args: [update.status, update.note, timestamp, update.organization.id] })); await client.execute("BEGIN"); try { await client.batch(statements, "write"); await client.execute("COMMIT"); } catch (error) { await client.execute("ROLLBACK"); throw error; } console.log(`[sync-audit] committed ${statements.length} update(s)`);
  } finally { client.close(); }
}
main().catch((error: unknown) => { console.error(`[sync-audit] failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
