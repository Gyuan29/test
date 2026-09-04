import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createClient } from "@libsql/client";

const root = resolve(import.meta.dirname, "../..");
const configuredPath = process.env.LOCAL_SQLITE_PATH?.trim() || ".local/d1.sqlite";
const databasePath = resolve(root, configuredPath);

function stamp(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

async function main(): Promise<void> {
  if (databasePath === ":memory:") throw new Error("LOCAL_SQLITE_PATH must point to a file for a safe migration");
  await mkdir(dirname(databasePath), { recursive: true });
  const client = createClient({ url: `file:${databasePath}` });
  try {
    const columns = await client.execute({ sql: "PRAGMA table_info(events)" });
    const hasCanonical = columns.rows.some((column) => column.name === "canonical_source_url");
    if (!hasCanonical) {
      const backupPath = `${databasePath}.before-canonical-source-url.${stamp()}`;
      await copyFile(databasePath, backupPath);
      console.log(`Backup created: ${backupPath}`);
      await client.execute({ sql: "BEGIN" });
      try {
        await client.execute({ sql: "ALTER TABLE events ADD COLUMN canonical_source_url TEXT" });
        await client.execute({ sql: "CREATE UNIQUE INDEX IF NOT EXISTS events_organization_canonical_source_uq ON events(organization_id, canonical_source_url)" });
        await client.execute({ sql: "COMMIT" });
      } catch (error) {
        await client.execute({ sql: "ROLLBACK" }).catch(() => undefined);
        throw error;
      }
      console.log("Added events.canonical_source_url and ensured its unique index.");
    } else {
      await client.execute({ sql: "CREATE UNIQUE INDEX IF NOT EXISTS events_organization_canonical_source_uq ON events(organization_id, canonical_source_url)" });
      console.log("events.canonical_source_url already exists; no column change needed.");
    }
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(`Event schema migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
