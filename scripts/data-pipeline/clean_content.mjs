import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

import { contentUpdates } from "../../lib/content-cleanup.js";
import { normalizeOfficialDomain } from "../../lib/official-domain.js";

const projectRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const configuredPath = process.env.LOCAL_SQLITE_PATH?.trim();
const databasePath = configuredPath ? resolve(projectRoot, configuredPath) : resolve(projectRoot, ".local", "d1.sqlite");
const apply = process.argv.includes("--apply");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportPath = resolve(projectRoot, "outputs", `content-cleanup-${timestamp}.json`);
const backupPath = `${databasePath}.backup-${timestamp}`;

function change(kind, id, field, before, after) {
  return { kind, id, field, before: before ?? null, after: after ?? null };
}

async function main() {
  if (databasePath === ":memory:") throw new Error("content cleanup requires a file-backed LOCAL_SQLITE_PATH");
  const client = createClient({ url: `file:${databasePath}` });
  const changes = [];
  try {
    const organizations = await client.execute("SELECT entity_id, website_url FROM organizations");
    for (const row of organizations.rows) {
      if (row.website_url != null && !normalizeOfficialDomain(String(row.website_url))) {
        changes.push(change("organization", String(row.entity_id), "website_url", row.website_url, null));
      }
    }

    const events = await client.execute("SELECT id, title, summary, translated_title, translated_description, event_date FROM events");
    for (const row of events.rows) {
      const updates = contentUpdates(row);
      for (const [field, after] of Object.entries(updates)) {
        if (after !== undefined && after !== row[field]) changes.push(change("event", String(row.id), field, row[field], after));
      }
    }

    const report = {
      generatedAt: new Date().toISOString(),
      mode: apply ? "apply" : "dry-run",
      databasePath,
      backupPath: apply ? backupPath : null,
      changeCount: changes.length,
      changes,
    };
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    if (!apply) {
      console.log(`[预览] 将修改 ${changes.length} 个字段。报告: ${reportPath}`);
      return;
    }

    mkdirSync(dirname(databasePath), { recursive: true });
    copyFileSync(databasePath, backupPath);
    const now = new Date().toISOString();
    for (const item of changes) {
      if (item.kind === "organization") {
        await client.execute({ sql: "UPDATE organizations SET website_url = ?, updated_at = ? WHERE entity_id = ?", args: [item.after, now, item.id] });
      } else {
        await client.execute({ sql: `UPDATE events SET ${item.field} = ? WHERE id = ?`, args: [item.after, item.id] });
      }
    }
    report.appliedAt = new Date().toISOString();
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`[完成] 修改 ${changes.length} 个字段。备份: ${backupPath}`);
    console.log(`[完成] 报告: ${reportPath}`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(`[清理] 失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
