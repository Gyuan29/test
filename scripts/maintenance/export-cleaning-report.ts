#!/usr/bin/env npx tsx
/** Export a read-only organization-name cleaning report. */
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const currentPath = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(ROOT, ".local", "d1.sqlite");
const beforePath = process.env.NAME_CLEAN_BEFORE_DB?.trim() || resolve(ROOT, ".local", "d1.sqlite.before-org-cleanup");
const progressPath = process.env.NAME_CLEAN_PROGRESS_FILE?.trim();
const outputPath = resolve(ROOT, "data", "org_name_cleaning_report_latest.json");

type Row = { entity_id: unknown; name: unknown };
type Progress = { taskId?: unknown; total?: unknown; corrected?: unknown; valid?: unknown; invalid?: unknown; failed?: unknown; skipped?: unknown; status?: unknown };
type Corrected = { entity_id: string; old_name: string; new_name: string };
type Valid = { entity_id: string; name: string };
type InvalidOrFailed = { entity_id: string; name: string; reason: string };

const asString = (value: unknown): string => typeof value === "string" ? value : value == null ? "" : String(value);
const dbUrl = (path: string): string => path === ":memory:" ? "file::memory:" : path.startsWith("file:") ? path : `file:${path}`;

function definitelyValid(name: string): boolean {
  return /^[A-Za-z][A-Za-z\s\-']{2,39}$/u.test(name) || /\b(University|Institute|Organization|Foundation|Association|Center|Centre|Lab|Laboratory|College|Academy|Authority|Department|Museum|Hospital|School|Council|Society|Federation|Agency|Corporation|Company)\b/i.test(name);
}

async function readOrganizations(path: string): Promise<Map<string, string>> {
  const client: Client = createClient({ url: dbUrl(path) });
  try {
    const result = await client.execute("SELECT entity_id, name FROM organizations ORDER BY entity_id");
    return new Map((result.rows as unknown as Row[]).map((row) => [asString(row.entity_id), asString(row.name)]));
  } finally {
    client.close();
  }
}

function readProgress(): Progress | undefined {
  if (!progressPath) return undefined;
  try {
    // Progress files are optional aggregate diagnostics; they do not contain entity-level outcomes.
    return JSON.parse(readFileSync(progressPath, "utf8")) as Progress;
  } catch {
    console.warn(`[export-cleaning-report] unable to read progress file: ${progressPath}`);
    return undefined;
  }
}

async function main(): Promise<void> {
  const current = await readOrganizations(currentPath);
  let before = new Map<string, string>();
  try {
    before = await readOrganizations(beforePath);
  } catch {
    console.warn(`[export-cleaning-report] before-cleanup database not available: ${beforePath}`);
  }

  const corrected: Corrected[] = [];
  for (const [entityId, name] of current) {
    const oldName = before.get(entityId);
    if (oldName !== undefined && oldName !== name) corrected.push({ entity_id: entityId, old_name: oldName, new_name: name });
  }
  corrected.sort((left, right) => left.entity_id.localeCompare(right.entity_id));
  const correctedIds = new Set(corrected.map((item) => item.entity_id));

  const valid: Valid[] = [];
  const invalidOrFailed: InvalidOrFailed[] = [];
  for (const [entityId, name] of current) {
    if (correctedIds.has(entityId)) continue;
    if (definitelyValid(name)) valid.push({ entity_id: entityId, name });
    else invalidOrFailed.push({ entity_id: entityId, name, reason: "aggregate_progress_only" });
  }
  valid.sort((left, right) => left.entity_id.localeCompare(right.entity_id));
  invalidOrFailed.sort((left, right) => left.entity_id.localeCompare(right.entity_id));

  const report = { corrected, valid, invalid_or_failed: invalidOrFailed };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8" });

  const progress = readProgress();
  console.log(`[export-cleaning-report] wrote ${outputPath}`);
  console.log(`[export-cleaning-report] corrected=${corrected.length} valid=${valid.length} invalid_or_failed=${invalidOrFailed.length}`);
  if (!before.size) console.warn("[export-cleaning-report] corrected records cannot be recovered without the before-cleanup database.");
  console.warn("[export-cleaning-report] The progress JSON contains aggregate counts only; individual INVALID/FAILED reasons are unavailable and are reported as aggregate_progress_only.");
  if (progress) console.log(`[export-cleaning-report] source progress task=${asString(progress.taskId) || "unknown"} status=${asString(progress.status) || "unknown"}`);
}

main().catch((error: unknown) => {
  console.error(`[export-cleaning-report] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
