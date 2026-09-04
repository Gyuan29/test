#!/usr/bin/env npx tsx
/** Read-only export of organization cleaning audit JSON files from SQLite. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DB_PATH = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(ROOT, ".local", "d1.sqlite");
const BEFORE_DB_PATH = process.env.NAME_CLEAN_BEFORE_DB?.trim();
const OUTPUT_DIR = resolve(ROOT, "data");
const VALID_OUTPUT = resolve(OUTPUT_DIR, "valid_names.json");
const AUDIT_OUTPUT = resolve(OUTPUT_DIR, "manual_audit_sample.json");

type Row = Record<string, unknown>;
type Organization = { entityId: string; name: string; originalName: string; status: string; note: string };
type Corrected = { old_name: string; new_name: string };
type Rejected = { name: string; attempted_correction: string };
type AuditReport = { corrected: Corrected[]; rejected_hallucinations: Rejected[]; invalid_descriptive_texts: string[]; failed_network_errors: string[] };

const asString = (value: unknown): string => typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
const dbUrl = (path: string): string => path === ":memory:" ? "file::memory:" : path.startsWith("file:") ? path : `file:${path}`;
const normalize = (value: string): string => value.toLocaleLowerCase().replace(/\s+/gu, " ").trim();

function parseArgs(): void {
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === "--" || !arg) continue;
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: node --import tsx scripts/maintenance/generate-cleaning-audit-json.ts");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
}

async function readOrganizations(path: string): Promise<Organization[]> {
  const client: Client = createClient({ url: dbUrl(path) });
  try {
    const schema = await client.execute("PRAGMA table_info(organizations)");
    const columns = new Set((schema.rows as unknown as Row[]).map((row) => asString(row.name)));
    const hasStatus = columns.has("cleaning_status");
    const hasNote = columns.has("audit_note");
    const statusSql = hasStatus ? "cleaning_status" : "NULL";
    const noteSql = hasNote ? "audit_note" : "NULL";
    const result = await client.execute(`SELECT entity_id, name, coalesce(original_name, '') AS original_name, ${statusSql} AS cleaning_status, ${noteSql} AS audit_note FROM organizations ORDER BY entity_id`);
    return (result.rows as unknown as Row[]).map((row) => ({ entityId: asString(row.entity_id), name: asString(row.name), originalName: asString(row.original_name), status: asString(row.cleaning_status), note: asString(row.audit_note) }));
  } finally {
    client.close();
  }
}

function suggestedName(note: string): string {
  const match = note.match(/(?:^|[;\s])suggested_name\s*=\s*([^;]+)/i);
  return match ? match[1].trim() : "";
}

function attemptedCorrection(note: string): string {
  const match = note.match(/(?:rejected hallucinated correction:|attempted_correction\s*=)\s*([^;]+)/i);
  return match ? match[1].trim() : "";
}

function buildReport(current: Organization[], before: Map<string, string>): { validNames: string[]; audit: AuditReport } {
  const corrected: Corrected[] = [];
  const rejected: Rejected[] = [];
  const invalid: string[] = [];
  const failed: string[] = [];
  const validNames: string[] = [];

  for (const organization of current) {
    const status = organization.status.toLocaleLowerCase();
    const newName = suggestedName(organization.note);
    if (status === "corrected") {
      corrected.push({ old_name: before.get(organization.entityId) || organization.originalName || organization.name, new_name: newName || organization.name });
    } else if (status === "rejected_hallucination") {
      rejected.push({ name: organization.name, attempted_correction: attemptedCorrection(organization.note) });
    } else if (status === "invalid_name") {
      invalid.push(organization.name);
    } else if (status === "needs_retry" || status === "api_timeout" || status === "network_error") {
      failed.push(organization.name);
    } else if (status === "valid" || status === "valid_confirmed") {
      validNames.push(organization.name);
    }
  }

  corrected.sort((left, right) => normalize(left.old_name).localeCompare(normalize(right.old_name)));
  rejected.sort((left, right) => normalize(left.name).localeCompare(normalize(right.name)));
  const uniqueSorted = (values: string[]): string[] => [...new Set(values)].sort((left, right) => normalize(left).localeCompare(normalize(right)));
  return {
    validNames: uniqueSorted(validNames),
    audit: { corrected, rejected_hallucinations: rejected, invalid_descriptive_texts: uniqueSorted(invalid), failed_network_errors: uniqueSorted(failed) },
  };
}

async function main(): Promise<void> {
  parseArgs();
  const current = await readOrganizations(DB_PATH);
  const hasAuditFields = current.some((organization) => organization.status || organization.note);
  if (!hasAuditFields) console.warn("[generate-cleaning-audit-json] No cleaning_status/audit_note values found; only explicitly tagged records can be exported.");

  let before = new Map<string, string>();
  if (BEFORE_DB_PATH) {
    try { before = new Map((await readOrganizations(BEFORE_DB_PATH)).map((organization) => [organization.entityId, organization.name])); }
    catch { console.warn(`[generate-cleaning-audit-json] before-cleanup database unavailable: ${BEFORE_DB_PATH}`); }
  }

  const report = buildReport(current, before);
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(VALID_OUTPUT, `${JSON.stringify({ valid_institutions: report.validNames }, null, 2)}\n`, "utf8");
  await writeFile(AUDIT_OUTPUT, `${JSON.stringify(report.audit, null, 2)}\n`, "utf8");
  console.log(`[generate-cleaning-audit-json] wrote ${VALID_OUTPUT}`);
  console.log(`[generate-cleaning-audit-json] wrote ${AUDIT_OUTPUT}`);
  console.log(`[generate-cleaning-audit-json] valid=${report.validNames.length} corrected=${report.audit.corrected.length} rejected=${report.audit.rejected_hallucinations.length} invalid=${report.audit.invalid_descriptive_texts.length} failed=${report.audit.failed_network_errors.length}`);
  console.log("[generate-cleaning-audit-json] read-only export; database and source files were not modified.");
}

main().catch((error: unknown) => { console.error(`[generate-cleaning-audit-json] failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
