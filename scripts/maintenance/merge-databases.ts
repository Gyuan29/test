#!/usr/bin/env npx tsx
/** Merge backup/branch SQLite data into the current database without overwriting current rows. */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type InValue } from "@libsql/client";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TARGET_PATH = process.env.MERGE_TARGET_PATH?.trim() || resolve(ROOT, ".local", "d1.sqlite");
const SOURCE_PATHS = [
  process.env.MERGE_BACKUP_PATH?.trim() || resolve(ROOT, "..", "institution-intel", ".local", "d1.sqlite.backup-2026-08-21T03-48-38-699Z"),
  process.env.MERGE_BRANCH_PATH?.trim() || resolve(ROOT, "..", "institution-intel-Gyuan", ".local", "d1.sqlite"),
];

type Row = Record<string, unknown>;
type Client = ReturnType<typeof createClient>;

function quoteIdentifier(identifier: string): string { return `"${identifier.replaceAll("\"", "\"\"")}"`; }
function value(value: unknown): InValue { return value == null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean" || value instanceof Uint8Array || value instanceof Date ? value as InValue : String(value); }
function nonEmpty(valueToCheck: unknown): boolean { return typeof valueToCheck === "string" ? valueToCheck.trim().length > 0 : valueToCheck != null; }
function key(valueToCheck: unknown): string | null { return nonEmpty(valueToCheck) ? String(valueToCheck).trim() : null; }

async function columns(client: Client, table: string): Promise<Row[]> {
  const result = await client.execute(`PRAGMA table_info(${quoteIdentifier(table)})`);
  if (result.rows.length === 0) throw new Error(`table ${table} is missing or has no columns`);
  return result.rows as Row[];
}

async function rows(client: Client, table: string): Promise<Row[]> {
  const result = await client.execute(`SELECT * FROM ${quoteIdentifier(table)}`);
  return result.rows as Row[];
}

function columnNames(info: Row[]): string[] { return info.map((item) => String(item.name)); }
function primaryKey(info: Row[], preferred: string): string {
  const names = columnNames(info);
  if (names.includes(preferred)) return preferred;
  if (names.includes("id")) return "id";
  throw new Error(`could not find ${preferred} or id primary key`);
}

function requiredMissing(targetInfo: Row[], sourceNames: Set<string>, mappings: Map<string, string>): string[] {
  return targetInfo.filter((item) => Number(item.notnull) === 1 && item.dflt_value == null && !sourceNames.has(String(item.name)) && !mappings.has(String(item.name))).map((item) => String(item.name));
}

async function insertRow(client: Client, table: string, targetNames: string[], sourceRow: Row, sourceNames: Set<string>, mappings: Map<string, string>): Promise<number> {
  const insertNames = targetNames.filter((name) => sourceNames.has(name) || mappings.has(name));
  const args = insertNames.map((name) => value(sourceRow[mappings.get(name) || name]));
  const placeholders = insertNames.map(() => "?").join(", ");
  const result = await client.execute({ sql: `INSERT OR IGNORE INTO ${quoteIdentifier(table)} (${insertNames.map(quoteIdentifier).join(", ")}) VALUES (${placeholders})`, args });
  return result.rowsAffected;
}

async function mergeOrganizations(target: Client, source: Client, sourceLabel: string): Promise<number> {
  const targetInfo = await columns(target, "organizations");
  const sourceInfo = await columns(source, "organizations");
  const targetNames = columnNames(targetInfo), sourceNames = new Set(columnNames(sourceInfo));
  const targetId = primaryKey(targetInfo, "entity_id"), sourceId = primaryKey(sourceInfo, "entity_id");
  const sourceRows = await rows(source, "organizations");
  const targetRows = await rows(target, "organizations");
  const known = new Map<string, Row>(targetRows.map((row) => [String(row[targetId]), row]));
  const mappings = new Map<string, string>();
  const missing = requiredMissing(targetInfo, sourceNames, mappings);
  if (missing.length > 0) throw new Error(`${sourceLabel}: organizations is missing required columns: ${missing.join(", ")}`);
  let added = 0, updated = 0;
  for (const sourceRow of sourceRows) {
    const id = key(sourceRow[sourceId]);
    if (!id) continue;
    const existing = known.get(id);
    if (!existing) {
      added += await insertRow(target, "organizations", targetNames, sourceRow, sourceNames, mappings);
      known.set(id, sourceRow);
      continue;
    }
    const changes: Array<[string, unknown]> = [];
    for (const field of ["description", "summary"]) {
      if (targetNames.includes(field) && sourceNames.has(field) && !nonEmpty(existing[field]) && nonEmpty(sourceRow[field])) changes.push([field, sourceRow[field]]);
    }
    if (changes.length > 0) {
      const result = await target.execute({ sql: `UPDATE organizations SET ${changes.map(([field]) => `${quoteIdentifier(field)} = ?`).join(", ")} WHERE ${quoteIdentifier(targetId)} = ?`, args: [...changes.map(([, fieldValue]) => value(fieldValue)), id] });
      if (result.rowsAffected > 0) { updated += 1; for (const [field, fieldValue] of changes) existing[field] = fieldValue; }
    }
  }
  console.log(`[merge] ${sourceLabel}: organizations added=${added}, descriptions updated=${updated}`);
  return added;
}

async function mergeEvents(target: Client, source: Client, sourceLabel: string): Promise<number> {
  const targetInfo = await columns(target, "events");
  const sourceInfo = await columns(source, "events");
  const targetNames = columnNames(targetInfo), sourceNames = new Set(columnNames(sourceInfo));
  const targetId = primaryKey(targetInfo, "id"), sourceId = primaryKey(sourceInfo, "id");
  const targetUrl = targetNames.includes("source_url") ? "source_url" : targetNames.includes("canonical_url") ? "canonical_url" : null;
  const sourceUrl = sourceNames.has("source_url") ? "source_url" : sourceNames.has("canonical_url") ? "canonical_url" : null;
  const mappings = new Map<string, string>();
  if (targetUrl && sourceUrl && targetUrl !== sourceUrl) mappings.set(targetUrl, sourceUrl);
  const missing = requiredMissing(targetInfo, sourceNames, mappings);
  if (missing.length > 0) throw new Error(`${sourceLabel}: events is missing required columns: ${missing.join(", ")}`);
  const targetRows = await rows(target, "events");
  const knownIds = new Set(targetRows.map((row) => key(row[targetId])).filter((item): item is string => item !== null));
  const knownUrls = new Set(targetRows.map((row) => targetUrl ? key(row[targetUrl]) : null).filter((item): item is string => item !== null));
  const organizationIds = new Set((await rows(target, "organizations")).map((row) => key(row.entity_id ?? row.id)).filter((item): item is string => item !== null));
  let added = 0;
  for (const sourceRow of await rows(source, "events")) {
    const id = key(sourceRow[sourceId]);
    const url = sourceUrl ? key(sourceRow[sourceUrl]) : null;
    if ((url && knownUrls.has(url)) || (!url && id && knownIds.has(id))) continue;
    const organizationId = key(sourceRow.organization_id);
    if (organizationId && !organizationIds.has(organizationId)) { console.warn(`[merge] ${sourceLabel}: skipped event ${id || "(no id)"}; organization ${organizationId} is absent`); continue; }
    const inserted = await insertRow(target, "events", targetNames, sourceRow, sourceNames, mappings);
    if (inserted > 0) { added += 1; if (id) knownIds.add(id); if (url) knownUrls.add(url); }
  }
  console.log(`[merge] ${sourceLabel}: events added=${added}`);
  return added;
}

async function main(): Promise<void> {
  if (!existsSync(TARGET_PATH)) throw new Error(`target database not found: ${TARGET_PATH}`);
  for (const sourcePath of SOURCE_PATHS) if (!existsSync(sourcePath)) throw new Error(`source database not found: ${sourcePath}`);
  mkdirSync(dirname(TARGET_PATH), { recursive: true });
  const safetyCopy = `${TARGET_PATH}.pre-merge.backup`;
  copyFileSync(TARGET_PATH, safetyCopy);
  console.log(`[merge] safety backup created: ${safetyCopy}`);
  const target = createClient({ url: `file:${TARGET_PATH}` });
  try {
    await target.execute("PRAGMA foreign_keys = ON");
    await target.execute("BEGIN");
    try {
      for (const sourcePath of SOURCE_PATHS) {
        const sourceLabel = sourcePath;
        const source = createClient({ url: `file:${sourcePath}` });
        try { await mergeOrganizations(target, source, sourceLabel); await mergeEvents(target, source, sourceLabel); }
        finally { source.close(); }
      }
      await target.execute("COMMIT");
      console.log("[merge] completed successfully; current rows were preserved on conflicts.");
    } catch (error) { await target.execute("ROLLBACK"); throw error; }
  } finally { target.close(); }
}

main().catch((error: unknown) => { console.error(`[merge] failed; transaction rolled back: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
