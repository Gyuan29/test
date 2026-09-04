#!/usr/bin/env npx tsx
/** Parse a UTF-8 cleaning log and generate audit JSON files without touching the database. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOG_PATH = process.env.CLEANING_LOG_PATH?.trim() || resolve(ROOT, "data", "data.txt");
const OUTPUT_DIR = resolve(ROOT, "data");
const VALID_PATH = resolve(OUTPUT_DIR, "valid_names.json");
const AUDIT_PATH = resolve(OUTPUT_DIR, "manual_audit_sample.json");

type Outcome = { position: number; total: number; kind: "valid" | "invalid" | "corrected" | "failed" | "rejected"; name: string; newName?: string; reason?: string };
type AuditReport = { corrected: Array<{ old_name: string; new_name: string }>; rejected_hallucinations: Array<{ name: string; attempted_correction: string }>; invalid_descriptive_texts: string[]; failed_network_errors: string[] };

function parseArgs(): void {
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === "--" || !arg) continue;
    if (arg === "--help" || arg === "-h") { console.log("Usage: node --import tsx scripts/maintenance/parse-log-and-generate-audit.ts"); process.exit(0); }
    throw new Error(`Unknown argument: ${arg}`);
  }
}

function parseOutcome(line: string): Outcome | undefined {
  const prefix = /^\[进度\s+(\d+)\/(\d+)\]\s+/u;
  const match = line.match(prefix);
  if (!match) return undefined;
  const position = Number(match[1]); const total = Number(match[2]); const body = line.slice(match[0].length).trim();
  const shortCircuit = body.match(/^(.*?)\s+->\s+VALID\s+\(short-circuit\)\s*$/u);
  if (shortCircuit) return { position, total, kind: "valid", name: shortCircuit[1].trim() };
  const completed = body.match(/^完成:\s+(.*?)\s+->\s+(VALID|INVALID|CORRECTED)(?:\s+\((.*)\))?\s*$/u);
  if (completed) return { position, total, kind: completed[2].toLocaleLowerCase() as Outcome["kind"], name: completed[1].trim(), newName: completed[2] === "CORRECTED" ? completed[3]?.trim() : undefined };
  const failed = body.match(/^失败:\s+(.*?)\s+\((api_timeout|network_error|llm_parse_failed)\)\s*$/u);
  if (failed) return { position, total, kind: "failed", name: failed[1].trim(), reason: failed[2] };
  const rejected = body.match(/^拒绝不受支持的纠正:\s+(.*?)\s+->\s+(.*?)\s*$/u);
  if (rejected) return { position, total, kind: "rejected", name: rejected[1].trim(), newName: rejected[2].trim() };
  return undefined;
}

function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }

function buildReports(outcomes: Outcome[]): { validNames: string[]; audit: AuditReport } {
  const validNames: string[] = []; const corrected: AuditReport["corrected"] = []; const rejected: AuditReport["rejected_hallucinations"] = []; const invalid: string[] = []; const failed: string[] = [];
  for (const outcome of outcomes.sort((left, right) => left.position - right.position)) {
    if (outcome.kind === "valid") validNames.push(outcome.name);
    else if (outcome.kind === "corrected") corrected.push({ old_name: outcome.name, new_name: outcome.newName || "" });
    else if (outcome.kind === "rejected") rejected.push({ name: outcome.name, attempted_correction: outcome.newName || "" });
    else if (outcome.kind === "invalid") invalid.push(outcome.name);
    else if (outcome.kind === "failed") failed.push(outcome.name);
  }
  return { validNames: unique(validNames), audit: { corrected, rejected_hallucinations: rejected, invalid_descriptive_texts: unique(invalid), failed_network_errors: unique(failed) } };
}

async function main(): Promise<void> {
  parseArgs();
  const text = await readFile(LOG_PATH, "utf8");
  const outcomes: Outcome[] = [];
  for (const line of text.split(/\r?\n/u)) { const outcome = parseOutcome(line); if (outcome) outcomes.push(outcome); }
  if (!outcomes.length) throw new Error(`No recognized progress result lines found in ${LOG_PATH}`);
  const totals = new Set(outcomes.map((outcome) => outcome.total));
  if (totals.size !== 1) throw new Error(`Inconsistent progress totals found: ${[...totals].join(", ")}`);
  const total = outcomes[0].total; const byPosition = new Map<number, Outcome>();
  for (const outcome of outcomes) { if (outcome.position < 1 || outcome.position > total) throw new Error(`Invalid progress position: ${outcome.position}/${total}`); if (byPosition.has(outcome.position)) throw new Error(`Duplicate result for progress position ${outcome.position}`); byPosition.set(outcome.position, outcome); }
  const missing = Array.from({ length: total }, (_, index) => index + 1).filter((position) => !byPosition.has(position));
  if (missing.length) throw new Error(`Missing ${missing.length} progress result(s): ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? "..." : ""}`);
  const report = buildReports([...byPosition.values()]);
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(VALID_PATH, `${JSON.stringify({ valid_institutions: report.validNames }, null, 2)}\n`, "utf8");
  await writeFile(AUDIT_PATH, `${JSON.stringify(report.audit, null, 2)}\n`, "utf8");
  console.log(`[parse-log] log=${LOG_PATH} total=${total} parsed=${outcomes.length}`);
  console.log(`[parse-log] valid=${report.validNames.length} corrected=${report.audit.corrected.length} rejected=${report.audit.rejected_hallucinations.length} invalid=${report.audit.invalid_descriptive_texts.length} failed=${report.audit.failed_network_errors.length}`);
  console.log(`[parse-log] wrote ${VALID_PATH}`); console.log(`[parse-log] wrote ${AUDIT_PATH}`);
}

main().catch((error: unknown) => { console.error(`[parse-log] failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
