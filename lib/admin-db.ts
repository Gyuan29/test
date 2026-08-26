import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@/db/schema";
import { getDatabase } from "@/lib/db";

let database: ReturnType<typeof drizzle<typeof schema>> | undefined;

/** Drizzle adapter for authenticated admin mutations. The public read APIs keep their D1-compatible adapter. */
export async function getAdminDatabase() {
  await getDatabase();
  if (database) return database;
  const path = process.env.LOCAL_SQLITE_PATH?.trim() || "./.local/d1.sqlite";
  const client = createClient({ url: path === ":memory:" ? "file::memory:" : `file:${path}` });
  database = drizzle(client, { schema });
  return database;
}
