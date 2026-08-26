/** Batch translate organization descriptions through the shared LLM client. */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { isNotNull, sql } from "drizzle-orm";
import { organizations } from "../../db/schema";
import { chatCompletion, LLM_MODEL_NAME } from "../../lib/llm-client";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const databasePath = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(root, ".local", "d1.sqlite");
const progressPath = resolve(root, "data", "translation_progress.json");
const errorsPath = resolve(root, "data", "translation_errors.log");
const SYSTEM_PROMPT = "Translate the user text into accurate, fluent Simplified Chinese. Output only the translation.";
const MAX_TRANSLATION_CHARS = 400;
const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 3;
const RETRY_WAIT_MS = 1_000;
const SUCCESS_WAIT_MS = 500;
const REQUEST_TIMEOUT_MS = 120_000;

type Progress = { completedIds: string[]; updatedAt: string };
type PreparedText = { text: string; truncated: boolean };
type FailedTranslation = { entityId: string; source: string; prepared: PreparedText };

function parseArgs(): { limit?: number; resume: boolean; retryFailed: boolean } {
  const values = process.argv.slice(2);
  const index = values.indexOf("--limit");
  const rawLimit = index >= 0 ? values[index + 1] : undefined;
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("--limit must be a positive integer");
  return { limit, resume: values.includes("--resume"), retryFailed: values.includes("--retry-failed") };
}

function loadProgress(resume: boolean): Progress {
  if (!resume) return { completedIds: [], updatedAt: new Date().toISOString() };
  try {
    const value = JSON.parse(readFileSync(progressPath, "utf8")) as { completedIds?: unknown };
    return { completedIds: Array.isArray(value.completedIds) ? value.completedIds.filter((id): id is string => typeof id === "string") : [], updatedAt: new Date().toISOString() };
  } catch { return { completedIds: [], updatedAt: new Date().toISOString() }; }
}

function saveProgress(progress: Progress, completed: Set<string>): void {
  progress.completedIds = [...completed]; progress.updatedAt = new Date().toISOString();
  mkdirSync(dirname(progressPath), { recursive: true });
  writeFileSync(progressPath, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
}

function chineseRatio(value: string): number {
  const chinese = (value.match(/[\u3400-\u9fff]/gu) || []).length;
  const lettersAndNumbers = (value.match(/[\p{L}\p{N}]/gu) || []).length;
  return lettersAndNumbers ? chinese / lettersAndNumbers : 1;
}

function prepareTranslationText(source: string): PreparedText {
  if (source.length <= MAX_TRANSLATION_CHARS) return { text: source, truncated: false };
  return { text: `${source.slice(0, MAX_TRANSLATION_CHARS)}...`, truncated: true };
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function sleep(milliseconds: number): Promise<void> { return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)); }

function recordTranslationError(entityId: string, source: string, errors: string[]): void {
  mkdirSync(dirname(errorsPath), { recursive: true });
  appendFileSync(errorsPath, `${JSON.stringify({ at: new Date().toISOString(), entityId, source, errors })}\n`, "utf8");
}

function loadFailedSources(): Map<string, string> {
  const failed = new Map<string, string>();
  try {
    for (const line of readFileSync(errorsPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as { entityId?: unknown; source?: unknown };
        if (typeof value.entityId === "string" && typeof value.source === "string") failed.set(value.entityId, value.source);
      } catch { /* Ignore malformed historical log lines. */ }
    }
  } catch { /* The log is optional on a first run. */ }
  return failed;
}

async function requestTranslation(source: string): Promise<string> {
  return chatCompletion(SYSTEM_PROMPT, source, { timeout: REQUEST_TIMEOUT_MS });
}

async function translateWithRetry(source: string): Promise<string> {
  const errors: string[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try { return await requestTranslation(source); } catch (error) {
      errors.push(`attempt ${attempt}: ${errorMessage(error)}`);
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_WAIT_MS);
    }
  }
  throw new Error(errors.join("; "));
}

async function main(): Promise<void> {
  const { limit, resume, retryFailed } = parseArgs();
  const progress = loadProgress(resume || retryFailed);
  const completed = new Set(progress.completedIds);
  const failedSources = retryFailed ? loadFailedSources() : new Map<string, string>();
  const client = createClient({ url: databasePath === ":memory:" ? "file::memory:" : `file:${databasePath}` });
  const db = drizzle(client);
  try {
    const rows = (await db.select({ entityId: organizations.entityId, description: organizations.description }).from(organizations).where(isNotNull(organizations.description)).all())
      .filter((row) => Boolean(row.description) && !completed.has(row.entityId) && (chineseRatio(row.description!) < 0.5 || failedSources.has(row.entityId)))
      .map((row) => { const source = failedSources.get(row.entityId); return source ? { ...row, description: source } : row; });
    const pending = limit ? rows.slice(0, limit) : rows;
    let success = 0; let failed = 0;
    for (let batchStart = 0; batchStart < pending.length; batchStart += BATCH_SIZE) {
      const batch = pending.slice(batchStart, batchStart + BATCH_SIZE);
      const batchFailures: FailedTranslation[] = [];
      for (const [offset, row] of batch.entries()) {
        const source = row.description!.trim(); const prepared = prepareTranslationText(source);
        try {
          const translated = await translateWithRetry(prepared.text);
          await db.update(organizations).set({ description: `[译] ${translated}`, updatedAt: new Date().toISOString() }).where(sql`${organizations.entityId} = ${row.entityId}`).run();
          completed.add(row.entityId); success += 1;
          console.log(`[${batchStart + offset + 1}/${pending.length}] translated ${row.entityId} (${LLM_MODEL_NAME})`);
          await sleep(SUCCESS_WAIT_MS);
        } catch (error) { batchFailures.push({ entityId: row.entityId, source, prepared }); console.error(`translation failed for ${row.entityId}: ${errorMessage(error)}`); }
        saveProgress(progress, completed);
      }
      for (const failure of batchFailures) {
        try {
          const translated = await translateWithRetry(failure.prepared.text);
          await db.update(organizations).set({ description: `[译] ${translated}`, updatedAt: new Date().toISOString() }).where(sql`${organizations.entityId} = ${failure.entityId}`).run();
          completed.add(failure.entityId); success += 1;
        } catch (error) { failed += 1; recordTranslationError(failure.entityId, failure.source, [errorMessage(error)]); }
        saveProgress(progress, completed);
      }
    }
    console.log(`completed: ${success} succeeded, ${failed} failed, ${rows.length - pending.length} skipped`);
  } finally { client.close(); }
}

main().catch((error) => { console.error(errorMessage(error)); process.exitCode = 1; });
