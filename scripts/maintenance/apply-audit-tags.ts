#!/usr/bin/env npx tsx
/** Apply manually audited organization-name tags. Database writes require explicit YES confirmation. */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createClient, type Client, type InStatement } from "@libsql/client";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DB_PATH = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(ROOT, ".local", "d1.sqlite");
const AUDIT_PATH = process.env.MANUAL_AUDIT_PATH?.trim() || resolve(ROOT, "data", "manual_audit_sample.json");
const DB_URL = DB_PATH === ":memory:" ? "file::memory:" : DB_PATH.startsWith("file:") ? DB_PATH : `file:${DB_PATH}`;

type Organization = { entity_id: string; name: string; original_name: string };
type AuditEntry = { name?: unknown; old_name?: unknown; new_name?: unknown; attempted_correction?: unknown } | string;
type AuditFile = { corrected?: unknown; rejected_hallucinations?: unknown; invalid_descriptive_texts?: unknown; failed_network_errors?: unknown };
type TagStatus = "corrected" | "rejected_hallucination" | "invalid_name" | "needs_retry";
type AuditTag = { status: TagStatus; detail: string };
type PendingUpdate = { organization: Organization; status: TagStatus; note: string; tags: AuditTag[] };

const REQUIRED_COLUMNS = ["cleaning_status", "audit_note", "retry_count"];
const STATUS_PRIORITY: Record<TagStatus, number> = { corrected: 1, rejected_hallucination: 2, invalid_name: 3, needs_retry: 4 };

function asString(value: unknown): string { return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim(); }
function normalize(value: string): string { return value.toLocaleLowerCase().replace(/\s+/gu, " ").trim(); }
function looseNormalize(value: string): string { return normalize(value).replace(/[^a-z0-9\u4e00-\u9fff]/gu, ""); }
function parseArgs(): boolean {
  let dryRun = process.argv.includes("--dry-run") || process.env.npm_config_dry_run === "true" || process.env.npm_config_dryRun === "true";
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === "--" || !arg) continue;
    if (arg === "--dry-run" || arg === "--dryRun") { dryRun = true; continue; }
    if (arg === "--help" || arg === "-h") { console.log("Usage: node --import tsx scripts/maintenance/apply-audit-tags.ts [--dry-run]"); process.exit(0); }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return dryRun;
}

async function readAuditFile(): Promise<AuditFile> {
  const parsed: unknown = JSON.parse(await readFile(AUDIT_PATH, "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("manual audit file must contain a JSON object");
  return parsed as AuditFile;
}

function entries(value: unknown): AuditEntry[] {
  return Array.isArray(value) ? value.filter((item): item is AuditEntry => typeof item === "string" || (!!item && typeof item === "object")) : [];
}

function entryName(entry: AuditEntry): string {
  return typeof entry === "string" ? entry : asString(entry.name || entry.old_name);
}

function tagFor(category: keyof AuditFile, entry: AuditEntry): AuditTag | undefined {
  const name = entryName(entry);
  if (!name) return undefined;
  if (category === "corrected") {
    const newName = typeof entry === "string" ? "" : asString(entry.new_name);
    return { status: "corrected", detail: newName ? `corrected to ${newName}` : "manually audited correction" };
  }
  if (category === "rejected_hallucinations") {
    const attempted = typeof entry === "string" ? "" : asString(entry.attempted_correction);
    return { status: "rejected_hallucination", detail: attempted ? `rejected hallucinated correction: ${attempted}` : "hallucinated correction rejected" };
  }
  if (category === "invalid_descriptive_texts") return { status: "invalid_name", detail: "descriptive text is not an organization name" };
  if (category === "failed_network_errors") return { status: "needs_retry", detail: "LLM request failed with a network error" };
  return undefined;
}

function collectTags(audit: AuditFile): Map<string, AuditTag[]> {
  const result = new Map<string, AuditTag[]>();
  const add = (name: string, tag: AuditTag): void => {
    const key = normalize(name);
    result.set(key, [...(result.get(key) || []), tag]);
  };
  const categories: (keyof AuditFile)[] = ["corrected", "rejected_hallucinations", "invalid_descriptive_texts", "failed_network_errors"];
  for (const category of categories) for (const entry of entries(audit[category])) {
    const name = entryName(entry);
    const tag = tagFor(category, entry);
    if (!name || !tag) continue;
    add(name, tag);
    if (category === "corrected" && typeof entry !== "string") {
      const newName = asString(entry.new_name);
      if (newName) add(newName, tag);
    }
  }
  return result;
}

async function readOrganizations(client: Client): Promise<Organization[]> {
  const result = await client.execute("SELECT entity_id, name, coalesce(original_name, '') AS original_name FROM organizations ORDER BY entity_id");
  return (result.rows as unknown as Record<string, unknown>[]).map((row) => ({ entity_id: asString(row.entity_id), name: asString(row.name), original_name: asString(row.original_name) }));
}

async function checkSchema(client: Client): Promise<void> {
  const result = await client.execute("PRAGMA table_info(organizations)");
  const columns = new Set((result.rows as unknown as Record<string, unknown>[]).map((row) => asString(row.name)));
  const missing = REQUIRED_COLUMNS.filter((column) => !columns.has(column));
  if (missing.length) throw new Error(`Missing columns: ${missing.join(", ")}. Apply the ALTER TABLE statements shown in the runbook before running this script.`);
}

function matchOrganizations(organizations: Organization[], auditName: string): Organization[] {
  const exact = organizations.filter((organization) => [organization.name, organization.original_name].some((value) => value === auditName));
  if (exact.length) return exact;
  const normalized = normalize(auditName);
  const normalizedMatches = organizations.filter((organization) => [organization.name, organization.original_name].some((value) => normalize(value) === normalized));
  if (normalizedMatches.length) return normalizedMatches;
  const loose = looseNormalize(auditName);
  if (!loose) return [];
  const looseMatches = organizations.filter((organization) => [organization.name, organization.original_name].some((value) => looseNormalize(value) === loose));
  return looseMatches.length === 1 ? looseMatches : [];
}

async function confirm(count: number): Promise<boolean> {
  const readline = createInterface({ input, output });
  try { return (await readline.question(`将更新 ${count} 条机构记录。请输入 YES 确认: `)) === "YES"; }
  finally { readline.close(); }
}

async function main(): Promise<void> {
  const dryRun = parseArgs();
  const audit = await readAuditFile();
  const tagsByName = collectTags(audit);
  const client: Client = createClient({ url: DB_URL });
  try {
    try { await checkSchema(client); }
    catch (error) {
      if (!dryRun) throw error;
      console.warn(`[audit-tags] dry-run schema warning: ${error instanceof Error ? error.message : String(error)}`);
    }
    const organizations = await readOrganizations(client);
    const updates = new Map<string, PendingUpdate>();
    let unmatched = 0;
    for (const [auditName, tags] of tagsByName) {
      const matches = matchOrganizations(organizations, auditName);
      if (!matches.length) { unmatched += 1; console.warn(`[audit-tags] unmatched: ${auditName}`); continue; }
      for (const organization of matches) {
        const existing = updates.get(organization.entity_id);
        const mergedTags = [...(existing?.tags || []), ...tags];
        const status = [...mergedTags].sort((left, right) => STATUS_PRIORITY[right.status] - STATUS_PRIORITY[left.status])[0].status;
        updates.set(organization.entity_id, { organization, status, note: [...new Set(mergedTags.map((tag) => tag.detail))].join("; "), tags: mergedTags });
      }
    }

    const pending = [...updates.values()].sort((left, right) => left.organization.entity_id.localeCompare(right.organization.entity_id));
    for (const update of pending) {
      console.log(`[audit-tags] ${dryRun ? "WOULD UPDATE" : "UPDATE"} ${update.organization.entity_id} ${update.organization.name} -> ${update.status}; ${update.note}`);
      if (dryRun) console.log(`[audit-tags] SQL: UPDATE organizations SET cleaning_status = ?, audit_note = ?, updated_at = ? WHERE entity_id = ?; args=[${JSON.stringify(update.status)}, ${JSON.stringify(update.note)}, <now>, ${JSON.stringify(update.organization.entity_id)}]`);
    }
    console.log(`[audit-tags] matched=${pending.length} unmatched_names=${unmatched} mode=${dryRun ? "DRY-RUN" : "LIVE"}`);
    if (dryRun || pending.length === 0) return;
    if (!(await confirm(pending.length))) { console.log("Confirmation failed; no database changes made."); return; }

    const statements: InStatement[] = pending.map((update) => ({
      sql: "UPDATE organizations SET cleaning_status = ?, audit_note = ?, updated_at = ? WHERE entity_id = ?",
      args: [update.status, update.note, new Date().toISOString(), update.organization.entity_id],
    }));
    await client.execute("BEGIN");
    try { await client.batch(statements, "write"); await client.execute("COMMIT"); }
    catch (error) { await client.execute("ROLLBACK"); throw error; }
    console.log(`[audit-tags] committed ${pending.length} update(s); retry_count was preserved for worker-managed retries.`);
  } finally { client.close(); }
}

main().catch((error: unknown) => { console.error(`[audit-tags] failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
