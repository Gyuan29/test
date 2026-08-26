import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const databasePath = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(projectRoot, ".local", "d1.sqlite");
const indexesPath = resolve(projectRoot, "db", "fts5.sql");
const migrationsFolder = resolve(projectRoot, "drizzle");

if (!existsSync(indexesPath)) {
  throw new Error(`Database indexes file not found: ${indexesPath}`);
}

if (databasePath !== ":memory:") {
  mkdirSync(dirname(databasePath), { recursive: true });
}

const url = databasePath === ":memory:" ? "file::memory:" : `file:${databasePath}`;
const client = createClient({ url });
const db = drizzle(client);

try {
  // Apply the checked-in Drizzle migration before the auxiliary indexes. This
  // keeps a fresh database self-contained and makes repeated runs idempotent.
  await migrate(db, { migrationsFolder });
  await client.executeMultiple(readFileSync(indexesPath, "utf8"));
  console.log(`初始化数据库表和标准索引: ${databasePath}`);
} finally {
  client.close();
}
