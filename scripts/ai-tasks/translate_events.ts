/** Translate event titles and summaries into Simplified Chinese without changing source text. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq, isNull, or } from "drizzle-orm";
import { events } from "../../db/schema";
import { chatCompletion, LLM_MODEL_NAME } from "../../lib/llm-client";

const databasePath = process.env.LOCAL_SQLITE_PATH?.trim() || "./.local/d1.sqlite";
const progressPath = resolve("data", "event_translation_progress.json");
const errorsPath = resolve("data", "translation_errors.log");
const SYSTEM_PROMPT = "Translate the event title and description into accurate, fluent Simplified Chinese. Return only JSON in the form {\"title\":\"...\",\"description\":\"...\"}.";

function parseArgs(): { limit?: number; resume: boolean } {
  const index = process.argv.indexOf("--limit");
  const limit = index < 0 ? undefined : Number(process.argv[index + 1]);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("--limit must be a positive integer");
  return { limit, resume: process.argv.includes("--resume") };
}

function loadProgress(resume: boolean): Set<string> {
  if (!resume || !existsSync(progressPath)) return new Set();
  try { const parsed = JSON.parse(readFileSync(progressPath, "utf8")) as { completedIds?: unknown }; return new Set(Array.isArray(parsed.completedIds) ? parsed.completedIds.filter((id): id is string => typeof id === "string") : []); } catch { return new Set(); }
}

function saveProgress(completed: Set<string>): void { mkdirSync(dirname(progressPath), { recursive: true }); writeFileSync(progressPath, `${JSON.stringify({ completedIds: [...completed], updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8"); }
function recordError(eventId: string, error: unknown): void { mkdirSync(dirname(errorsPath), { recursive: true }); appendFileSync(errorsPath, `${JSON.stringify({ at: new Date().toISOString(), eventId, error: error instanceof Error ? error.message : String(error) })}\n`, "utf8"); }

function parseTranslation(value: string, fallbackTitle: string, fallbackDescription: string): { title: string; description: string } {
  try {
    const parsed = JSON.parse(value) as { title?: unknown; description?: unknown };
    return { title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : fallbackTitle, description: typeof parsed.description === "string" && parsed.description.trim() ? parsed.description.trim() : fallbackDescription };
  } catch { return { title: value.trim() || fallbackTitle, description: fallbackDescription }; }
}

async function main(): Promise<void> {
  const client = createClient({ url: databasePath === ":memory:" ? "file::memory:" : `file:${databasePath}` });
  const db = drizzle(client);
  try {
    const { limit, resume } = parseArgs();
    const completed = loadProgress(resume);
    const candidates = await db.select().from(events).where(or(isNull(events.translatedTitle), isNull(events.translatedDescription))).limit(limit ?? 100000);
    const pending = candidates.filter((event) => !completed.has(event.id));
    for (const [index, event] of pending.entries()) {
      try {
        const sourceDescription = event.summary?.trim() || event.title;
        const translated = parseTranslation(await chatCompletion(SYSTEM_PROMPT, `Title: ${event.title}\nDescription: ${sourceDescription}`, { timeout: 120_000 }), event.title, sourceDescription);
        await db.update(events).set({ translatedTitle: translated.title, translatedDescription: translated.description }).where(eq(events.id, event.id));
        completed.add(event.id); saveProgress(completed);
        console.log(`[${index + 1}/${pending.length}] translated ${event.id} (${LLM_MODEL_NAME})`);
      } catch (error) { recordError(event.id, error); console.error(`translation failed for ${event.id}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    console.log(`completed: ${pending.length} events processed`);
  } finally { client.close(); }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
