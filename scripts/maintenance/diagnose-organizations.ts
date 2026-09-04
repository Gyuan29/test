#!/usr/bin/env npx tsx
/** Read-only quality report for organizations and their related events. */
import { createClient, type Client } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DB_PATH = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(ROOT, ".local", "d1.sqlite");
const DB_URL = DB_PATH === ":memory:" ? "file::memory:" : DB_PATH.startsWith("file:") ? DB_PATH : `file:${DB_PATH}`;

type Row = Record<string, unknown>;
type CountRow = { count: unknown };

function count(rows: Row[]): number {
  const value = (rows[0] as CountRow | undefined)?.count;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function domainColumn(client: Client): Promise<"website_url" | "official_domain"> {
  const result = await client.execute("PRAGMA table_info(organizations)");
  const columns = new Set(result.rows.map((row) => String((row as Row).name)));
  if (columns.has("website_url")) return "website_url";
  if (columns.has("official_domain")) return "official_domain";
  throw new Error("organizations table has neither website_url nor official_domain");
}

async function main(): Promise<void> {
  if (DB_PATH !== ":memory:" && !DB_PATH.startsWith("file:")) mkdirSync(dirname(DB_PATH), { recursive: true });
  const client = createClient({ url: DB_URL });
  try {
    await client.execute("PRAGMA foreign_keys = ON");
    const officialDomain = await domainColumn(client);
    const queries: Array<{ label: string; sql: string }> = [
      { label: "Organization total", sql: "SELECT COUNT(*) AS count FROM organizations" },
      { label: "Missing name or name length < 2", sql: "SELECT COUNT(*) AS count FROM organizations WHERE name IS NULL OR length(trim(name)) < 2" },
      { label: "Missing official_domain and description", sql: `SELECT COUNT(*) AS count FROM organizations WHERE COALESCE(trim(${officialDomain}), '') = '' AND COALESCE(trim(description), '') = ''` },
      { label: "Organizations with zero events", sql: "SELECT COUNT(*) AS count FROM organizations AS o WHERE NOT EXISTS (SELECT 1 FROM events AS e WHERE e.organization_id = o.entity_id)" },
      { label: "Exact duplicate-name groups", sql: "SELECT COUNT(*) AS count FROM (SELECT name FROM organizations GROUP BY name HAVING COUNT(*) > 1) AS duplicate_groups" },
    ];
    const values: Array<{ label: string; value: number }> = [];
    for (const query of queries) {
      const result = await client.execute(query.sql);
      values.push({ label: query.label, value: count(result.rows as unknown as Row[]) });
    }
    console.log("\nOrganization data quality report");
    console.log("====================");
    console.log(`Database: ${DB_PATH}`);
    console.log(`Official-domain column: ${officialDomain}\n`);
    console.log("| Metric | Count |");
    console.log("| --- | ---: |");
    for (const item of values) console.log(`| ${item.label} | ${item.value.toLocaleString("en-US")} |`);
    console.log("\nRead-only report; no database changes were made.\n");
  } finally {
    client.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[diagnose] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
