#!/usr/bin/env npx tsx
/** Read-only report for organization names that look like page copy rather than entities. */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DB_PATH = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(ROOT, ".local", "d1.sqlite");
const DB_URL = DB_PATH === ":memory:" ? "file::memory:" : DB_PATH.startsWith("file:") ? DB_PATH : `file:${DB_PATH}`;
const DESCRIPTIVE_PATTERN = /(\u7684|\u4e86|\u8fdb\u4e00\u6b65|\u8d77\u6e90\u4e8e|\u8dfa\u8eab|\u843d\u5b9e|\u6218\u7565\u5e03\u5c40|\u5e73\u53f0|\u603b\u90e8|\u7814\u53d1\u4e2d\u5fc3)/u;
type Row = Record<string, unknown>;
const asString = (value: unknown): string => typeof value === "string" ? value : value == null ? "" : String(value);
async function main(): Promise<void> {
  if (DB_PATH !== ":memory:" && !DB_PATH.startsWith("file:")) mkdirSync(dirname(DB_PATH), { recursive: true });
  const client: Client = createClient({ url: DB_URL });
  try {
    const rows = await client.execute("SELECT entity_id, slug, name, length(trim(name)) AS name_length FROM organizations ORDER BY name_length DESC, name");
    const all = rows.rows as unknown as Row[];
    const candidates = all.filter((row) => { const name = asString(row.name).trim(); return name.length > 20 || DESCRIPTIVE_PATTERN.test(name); });
    const longCount = all.filter((row) => asString(row.name).trim().length > 20).length;
    const descriptiveCount = all.filter((row) => DESCRIPTIVE_PATTERN.test(asString(row.name).trim())).length;
    console.log("Organization name quality report"); console.log(`Database: ${DB_PATH}`); console.log(`Total organizations: ${all.length}`); console.log(`Names longer than 20 characters: ${longCount}`); console.log(`Names containing descriptive markers: ${descriptiveCount}`); console.log(`Unique suspicious organizations (OR): ${candidates.length}`);
    if (candidates.length) { console.log("\nentity_id | slug | length | name"); for (const row of candidates) console.log(`${asString(row.entity_id)} | ${asString(row.slug)} | ${asString(row.name_length)} | ${asString(row.name)}`); }
    console.log("\nRead-only report; no database changes were made.");
  } finally { client.close(); }
}
main().catch((error: unknown) => { console.error(`[diagnose-names] failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
