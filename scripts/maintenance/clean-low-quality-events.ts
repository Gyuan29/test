#!/usr/bin/env npx tsx
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createClient, type InStatement } from "@libsql/client";
import pLimit from "p-limit";
import { chatCompletion, LLM_MODEL_NAME } from "../../lib/llm-client";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DB_PATH = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(ROOT, ".local", "d1.sqlite");
const DEFAULT_BATCH_SIZE = 15;
const LLM_CONCURRENCY = 3;
const LOW_SCORE = 6;
const KEYWORDS = ["登录", "注册", "广告", "cookie", "404", "undefined", "null", "首页", "加载中"];
const HARD_RULE_SQL = KEYWORDS.map(() => "lower(coalesce(title, '')) LIKE ? OR lower(coalesce(summary, '')) LIKE ?").join(" OR ");
const HARD_RULE_ARGS = KEYWORDS.flatMap((keyword) => [`%${keyword.toLowerCase()}%`, `%${keyword.toLowerCase()}%`]);

type EventRow = { id: string; title: string; summary: string | null; source_url: string | null; relevance_score: number | null };
type Decision = { event: EventRow; score: number | null; error?: string };

const SYSTEM_PROMPT = [
  "You are a strict but context-aware news-event quality reviewer.",
  "Re-score the supplied institutional event from 1 to 10.",
  "Give 6 or higher for a substantive institutional development, such as a partnership, launch, appointment, policy decision, award, research result, funding, or material announcement.",
  "Do not penalize a substantive article merely because it also contains navigation, cookie notices, login prompts, or advertisements.",
  "Give below 6 for navigation pages, homepages, generic service pages, recruitment boilerplate, duplicate listings, error pages, or content with no concrete institutional development.",
  "Return only valid JSON in exactly this form: {\"new_score\": 1}. The value must be an integer from 1 through 10.",
].join(" ");

function parseArgs(): { isDryRun: boolean; batchSize: number } {
  let isDryRun = process.argv.includes("--dry-run") || process.env.npm_config_dry_run === "true" || process.env.npm_config_dryRun === "true";
  let batchSize = DEFAULT_BATCH_SIZE;
  for (let index = 2; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (token === "--" || !token.startsWith("-")) continue;
    if (token === "--dry-run" || token === "--dryRun") { isDryRun = true; continue; }
    if (token === "--help" || token === "-h") {
      console.log("Usage: npm run maintenance:clean-events -- [--dry-run|--dryRun] [--batch-size N]");
      process.exit(0);
    }
    if (token === "--batch-size") {
      const raw = process.argv[index + 1];
      if (!raw || raw.startsWith("-")) throw new Error("--batch-size requires an integer between 10 and 20");
      batchSize = parseBatchSize(raw); index += 1; continue;
    }
    if (token.startsWith("--batch-size=")) { batchSize = parseBatchSize(token.slice(13)); continue; }
    throw new Error(`Unknown argument: ${token}`);
  }
  console.log(`[clean] mode=${isDryRun ? "DRY-RUN (read-only)" : "LIVE (confirmation required)"}; batch-size=${batchSize}`);
  return { isDryRun, batchSize };
}

function parseBatchSize(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new Error("--batch-size must be an integer between 10 and 20");
  const value = Number.parseInt(raw, 10);
  if (value < 10 || value > 20) throw new Error("--batch-size must be an integer between 10 and 20");
  return value;
}

function display(event: EventRow): string { return `${event.id} | ${event.title} | ${event.source_url || "(no source URL)"}`; }
function chunk<T>(items: T[], size: number): T[][] { const chunks: T[][] = []; for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size)); return chunks; }

async function writeStatements(client: ReturnType<typeof createClient>, statements: InStatement[]): Promise<void> {
  if (statements.length === 0) return;
  try { await client.batch(statements, "write"); }
  catch (error) {
    console.error(`[clean] batch write failed; retrying row by row: ${error instanceof Error ? error.message : String(error)}`);
    for (const statement of statements) {
      try { await client.execute(statement); }
      catch (itemError) { console.error(`[clean] row write failed: ${itemError instanceof Error ? itemError.message : String(itemError)}`); }
    }
  }
}

function parseScore(response: string): number | null {
  const body = response.match(/\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`/i)?.[1]?.trim() || response.trim();
  try {
    const parsed = JSON.parse(body) as { new_score?: unknown; newScore?: unknown; relevance_score?: unknown };
    const value = Number(parsed.new_score ?? parsed.newScore ?? parsed.relevance_score);
    return Number.isInteger(value) && value >= 1 && value <= 10 ? value : null;
  } catch {
    const match = body.match(/(?:new_score|newScore|relevance_score)\s*["']?\s*:\s*(\d{1,2})/i);
    const value = match ? Number(match[1]) : NaN;
    return Number.isInteger(value) && value >= 1 && value <= 10 ? value : null;
  }
}

async function review(event: EventRow): Promise<Decision> {
  try {
    const response = await chatCompletion(SYSTEM_PROMPT, JSON.stringify({ title: event.title, summary: event.summary || "", source_url: event.source_url || "" }), { timeout: 120_000, model: LLM_MODEL_NAME });
    const score = parseScore(response);
    if (score === null) throw new Error(`invalid LLM score: ${response.slice(0, 160)}`);
    return { event, score };
  } catch (error) { return { event, score: null, error: error instanceof Error ? error.message : String(error) }; }
}

async function confirmWrites(count: number): Promise<boolean> {
  console.error(`\x1b[31m⚠️ 警告：即将实际删除/修改数据库中的 ${count} 条记录！此操作不可逆。\x1b[0m`);
  const readline = createInterface({ input, output });
  try {
    const answer = await readline.question("请输入 'YES' (区分大小写) 确认继续，或按 Ctrl+C 取消：");
    if (answer !== "YES") { console.log("已取消"); process.exit(0); }
    return true;
  } finally { readline.close(); }
}

async function main(): Promise<void> {
  const { isDryRun, batchSize } = parseArgs();
  if (DB_PATH !== ":memory:") mkdirSync(dirname(DB_PATH), { recursive: true });
  const client = createClient({ url: DB_PATH === ":memory:" ? "file::memory:" : `file:${DB_PATH}` });
  try {
    const hardRows = await client.execute({ sql: `SELECT id, title, summary, source_url, relevance_score FROM events WHERE ${HARD_RULE_SQL}`, args: HARD_RULE_ARGS });
    const hardEvents = hardRows.rows as unknown as EventRow[];
    const hardIds = new Set(hardEvents.map((event) => event.id));
    const decisions: Decision[] = [];
    let processed = 0, deleted = 0, upgraded = 0, retained = 0, failed = 0;
    const limiter = pLimit(LLM_CONCURRENCY);
    let cursor = "";
    while (true) {
      const lowRows = await client.execute({ sql: "SELECT id, title, summary, source_url, relevance_score FROM events WHERE relevance_score < ? AND id > ? ORDER BY id ASC LIMIT ?", args: [LOW_SCORE, cursor, batchSize] });
      const rawBatch = lowRows.rows as unknown as EventRow[];
      if (rawBatch.length === 0) break;
      cursor = rawBatch[rawBatch.length - 1].id;
      const eventsBatch = rawBatch.filter((event) => !hardIds.has(event.id));
      if (eventsBatch.length === 0) continue;
      const batchDecisions = await Promise.all(eventsBatch.map((event) => limiter(() => review(event))));
      decisions.push(...batchDecisions); processed += eventsBatch.length;
      for (const decision of batchDecisions) {
        if (decision.error || decision.score === null) { failed += 1; retained += 1; }
        else if (decision.score >= LOW_SCORE) upgraded += 1;
        else deleted += 1;
      }
    }
    const planned = hardEvents.length + deleted + upgraded;
    console.log(`[clean] phase 1 rule matches: ${hardEvents.length}; phase 2 reviewed: ${processed}; deletes: ${hardEvents.length + deleted}; score updates: ${upgraded}; retained: ${retained}; failures: ${failed}`);
    if (isDryRun) {
      for (const event of hardEvents) console.log(`[Dry-Run] would delete rule match: ${display(event)}`);
      for (const decision of decisions) {
        if (decision.error || decision.score === null) console.log(`[Dry-Run] retain (LLM failure): ${decision.event.id}`);
        else if (decision.score >= LOW_SCORE) console.log(`[Dry-Run] would update score: ${decision.event.id} ${decision.event.relevance_score ?? "NULL"} -> ${decision.score}`);
        else console.log(`[Dry-Run] would delete low-score event: ${display(decision.event)} (new_score=${decision.score})`);
      }
      console.log(`[clean] dry-run complete; no database writes (${planned} planned changes).`);
      return;
    }
    if (!(await confirmWrites(planned))) return;
    for (const part of chunk(hardEvents, 100)) await writeStatements(client, part.map((event) => ({ sql: "DELETE FROM events WHERE id = ?", args: [event.id] })));
    const statements: InStatement[] = [];
    for (const decision of decisions) {
      if (decision.error || decision.score === null) continue;
      if (decision.score >= LOW_SCORE) statements.push({ sql: "UPDATE events SET relevance_score = ? WHERE id = ?", args: [decision.score, decision.event.id] });
      else statements.push({ sql: "DELETE FROM events WHERE id = ?", args: [decision.event.id] });
    }
    for (const part of chunk(statements, 100)) await writeStatements(client, part);
    console.log(`[clean] complete; deleted ${hardEvents.length + deleted}, updated ${upgraded}.`);
  } finally { client.close(); }
}

main().catch((error: unknown) => { console.error(`[clean] task failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
