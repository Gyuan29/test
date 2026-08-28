#!/usr/bin/env npx tsx
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dbPath = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(root, ".local/d1.sqlite");
const client = createClient({ url: dbPath === ":memory:" ? "file::memory:" : `file:${dbPath}` });

try {
  const count = await client.execute("SELECT COUNT(*) AS count FROM events");
  const removed = Number(count.rows[0]?.count || 0);
  await client.batch([
    { sql: "DELETE FROM events", args: [] },
    { sql: "UPDATE organizations SET search_status = 'pending', event_search_status = 'pending', last_event_searched_at = NULL, updated_at = CURRENT_TIMESTAMP", args: [] },
  ], "write");
  console.log(`已清理 ${removed} 条事件记录，并将机构搜索状态重置为 pending。`);
  console.log("请重新执行 npm run ai:search-news");
} finally {
  client.close();
}
