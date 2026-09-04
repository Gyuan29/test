#!/usr/bin/env npx tsx
/** Safely remove invalid, empty-shell, and exact-duplicate organizations. */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client, type InStatement } from "@libsql/client";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DB_PATH = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(ROOT, ".local", "d1.sqlite");
const DB_URL = DB_PATH === ":memory:" ? "file::memory:" : DB_PATH.startsWith("file:") ? DB_PATH : `file:${DB_PATH}`;
const WRITE_CHUNK_SIZE = 400;

type Row = Record<string, unknown>;
type OrganizationRow = { entity_id: unknown; name: unknown; description: unknown };
type EventCountRow = { count: unknown };
type Candidate = { id: string; name: string; description: string | null };
type DomainColumn = "website_url" | "official_domain";
type Plan = { invalid: Candidate[]; shells: Candidate[]; duplicates: Candidate[]; all: Candidate[]; duplicateGroups: number; eventCount: number };

function asString(value: unknown): string { return typeof value === "string" ? value : value == null ? "" : String(value); }
function chunk<T>(items: T[], size: number): T[][] { const result: T[][] = []; for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size)); return result; }
function ids(items: Candidate[]): string[] { return items.map((item) => item.id); }

async function domainColumn(client: Client): Promise<DomainColumn> {
  const result = await client.execute("PRAGMA table_info(organizations)");
  const columns = new Set(result.rows.map((row) => String((row as Row).name)));
  if (columns.has("website_url")) return "website_url";
  if (columns.has("official_domain")) return "official_domain";
  throw new Error("organizations table has neither website_url nor official_domain");
}

function candidate(row: OrganizationRow): Candidate {
  return { id: asString(row.entity_id), name: asString(row.name), description: typeof row.description === "string" ? row.description : null };
}

async function buildPlan(client: Client, officialDomain: DomainColumn): Promise<Plan> {
  const invalidResult = await client.execute({
    sql: `SELECT entity_id, name, description FROM organizations WHERE name IS NULL OR trim(name) = '' OR name LIKE '%<%>%' OR instr(lower(name), '<div') > 0 OR instr(lower(name), '</div') > 0 OR instr(lower(name), '<a') > 0 OR instr(lower(name), '</a') > 0 OR instr(lower(name), '<span') > 0 OR instr(lower(name), '</span') > 0`,
    args: [],
  });
  const invalid = (invalidResult.rows as unknown as OrganizationRow[]).map(candidate);
  const invalidIds = new Set(ids(invalid));
  const shellResult = await client.execute({
    sql: `SELECT o.entity_id, o.name, o.description FROM organizations AS o WHERE COALESCE(trim(o.${officialDomain}), '') = '' AND (COALESCE(trim(o.description), '') = '' OR length(trim(o.description)) < 10) AND NOT EXISTS (SELECT 1 FROM events AS e WHERE e.organization_id = o.entity_id)`,
    args: [],
  });
  const shells = (shellResult.rows as unknown as OrganizationRow[]).map(candidate).filter((item) => !invalidIds.has(item.id));
  const removedBeforeDuplicates = new Set([...invalidIds, ...ids(shells)]);
  const duplicateRowsResult = await client.execute({
    sql: "SELECT entity_id, name, description FROM organizations WHERE name IS NOT NULL AND name IN (SELECT name FROM organizations WHERE name IS NOT NULL GROUP BY name HAVING COUNT(*) > 1) ORDER BY name ASC, CASE WHEN trim(COALESCE(description, '')) <> '' THEN 0 ELSE 1 END ASC, entity_id ASC",
    args: [],
  });
  const duplicateRows = (duplicateRowsResult.rows as unknown as OrganizationRow[]).map(candidate).filter((item) => !removedBeforeDuplicates.has(item.id));
  const duplicateGroups = new Map<string, Candidate[]>();
  for (const item of duplicateRows) {
    const group = duplicateGroups.get(item.name) ?? [];
    group.push(item);
    duplicateGroups.set(item.name, group);
  }
  const duplicateGroupsWithRemainders = [...duplicateGroups.values()].filter((group) => group.length > 1);
  const duplicates: Candidate[] = [];
  for (const group of duplicateGroupsWithRemainders) duplicates.push(...group.slice(1));
  const all = [...invalid, ...shells, ...duplicates];
  const uniqueAll = [...new Map(all.map((item) => [item.id, item])).values()];
  let eventCount = 0;
  for (const part of chunk(ids(uniqueAll), WRITE_CHUNK_SIZE)) {
    if (part.length === 0) continue;
    const placeholders = part.map(() => "?").join(", ");
    const result = await client.execute({ sql: `SELECT COUNT(*) AS count FROM events WHERE organization_id IN (${placeholders})`, args: part });
    const raw = (result.rows[0] as unknown as EventCountRow | undefined)?.count;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) eventCount += parsed;
  }
  return { invalid, shells, duplicates, all: uniqueAll, duplicateGroups: duplicateGroupsWithRemainders.length, eventCount };
}

function printPlan(plan: Plan, dryRun: boolean): void {
  console.log(`\nOrganization cleanup preview (${dryRun ? "DRY-RUN, read-only" : "LIVE execution"})`);
  console.log("========================");
  console.log(`Rule A invalid names: ${plan.invalid.length}`);
  console.log(`Rule B empty shells: ${plan.shells.length}`);
  console.log(`Rule C exact duplicate groups: ${plan.duplicateGroups}; duplicate organizations to delete: ${plan.duplicates.length}`);
  console.log(`Unique organizations to delete: ${plan.all.length}`);
  console.log(`Related events to delete: ${plan.eventCount}`);
  if (plan.all.length > 0) {
    console.log("\nOrganizations to delete (first 20):");
    for (const item of plan.all.slice(0, 20)) console.log(`- ${item.id} | ${item.name || "(empty name)"}`);
    if (plan.all.length > 20) console.log(`- ... ${plan.all.length - 20} more omitted`);
  }
}

async function confirmWrites(plan: Plan): Promise<boolean> {
  console.error(`\nWARNING: ${plan.all.length} organizations and ${plan.eventCount} related events will be deleted. This cannot be undone.`);
  const readline = createInterface({ input, output });
  try {
    const answer = await readline.question("Type exactly YES (case-sensitive) to continue: ");
    if (answer !== "YES") { console.log("Confirmation failed; exited safely without database changes."); return false; }
    return true;
  } finally { readline.close(); }
}

async function deleteByIds(client: Client, table: "events" | "organizations", column: "organization_id" | "entity_id", values: string[]): Promise<void> {
  for (const part of chunk(values, WRITE_CHUNK_SIZE)) {
    if (part.length === 0) continue;
    const placeholders = part.map(() => "?").join(", ");
    const statement: InStatement = { sql: `DELETE FROM ${table} WHERE ${column} IN (${placeholders})`, args: part };
    await client.execute(statement);
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run") || process.env.npm_config_dry_run === "true" || process.env.npm_config_dryRun === "true";
  const unknown = process.argv.slice(2).filter((arg) => arg !== "--dry-run" && arg !== "--dryRun");
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(", ")}. Usage: npm run maintenance:clean-orgs -- [--dry-run]`);
  if (DB_PATH !== ":memory:" && !DB_PATH.startsWith("file:")) mkdirSync(dirname(DB_PATH), { recursive: true });
  const client = createClient({ url: DB_URL });
  try {
    await client.execute("PRAGMA foreign_keys = ON");
    const officialDomain = await domainColumn(client);
    const plan = await buildPlan(client, officialDomain);
    printPlan(plan, dryRun);
    if (dryRun) { console.log("\nDRY-RUN complete: no DELETE or other write operation was executed."); return; }
    if (!(await confirmWrites(plan))) return;
    if (plan.all.length === 0) { console.log("No organizations require deletion."); return; }
    const organizationIds = ids(plan.all);
    await client.execute("BEGIN");
    try {
      await deleteByIds(client, "events", "organization_id", organizationIds);
      await deleteByIds(client, "organizations", "entity_id", organizationIds);
      await client.execute("COMMIT");
    } catch (error) {
      await client.execute("ROLLBACK");
      throw error;
    }
    console.log(`\nCleanup complete: deleted ${organizationIds.length} organizations and ${plan.eventCount} related events.`);
  } finally { client.close(); }
}

main().catch((error: unknown) => {
  console.error(`[clean-orgs] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
