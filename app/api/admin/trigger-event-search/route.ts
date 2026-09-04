import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Body = { skipHours?: unknown; limit?: unknown; force?: unknown; days?: unknown };
const DEFAULT_EVENT_LOOKBACK_DAYS = Number(process.env.EVENT_LOOKBACK_DAYS) || 365;
function integer(value: unknown, fallback: number, minimum = 0): number | null { if (value === undefined) return fallback; const parsed = typeof value === "number" ? value : Number(value); return Number.isInteger(parsed) && parsed >= minimum ? parsed : null; }
function safeTaskId(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96) || "default"; }
function progressPathForTask(taskId: string): string { return resolve(process.cwd(), "data", `event_search_progress_${safeTaskId(taskId)}.json`); }
function writeProgress(path: string, progress: Record<string, unknown>): void {
  const body = `${JSON.stringify({ ...progress, lastUpdated: new Date().toISOString() }, null, 2)}\n`;
  const temporaryPath = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, body, { encoding: "utf8", flag: "wx" });
    try {
      renameSync(temporaryPath, path);
    } catch (error) {
      console.error(`[进度] 原子替换失败，尝试兼容性写入: ${error instanceof Error ? error.message : String(error)}`);
      writeFileSync(path, body, "utf8");
      try { unlinkSync(temporaryPath); } catch { /* The fallback may have already moved or removed it. */ }
    }
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* Preserve the original write error. */ }
    throw error;
  }
}
function markFailed(path: string, taskId: string, message: string): void { try { const current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> : {}; if (current.taskId && current.taskId !== taskId) return; writeProgress(path, { ...current, taskId, status: "failed", message }); } catch (error) { console.error(`[trigger-event-search:${taskId}] progress failure`, error); } }
function markRunning(path: string, taskId: string): void { try { const current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> : {}; if (current.taskId !== taskId || (current.status && current.status !== "starting")) return; writeProgress(path, { ...current, status: "running" }); } catch (error) { console.error(`[trigger-event-search:${taskId}] progress failure`, error); } }

export async function POST(request: NextRequest) {
  const denied = await requireAdmin(request); if (denied) return denied;
  const body = await request.json().catch(() => ({})) as Body;
  const skipHours = integer(body.skipHours, 24); const limit = body.limit === undefined ? null : integer(body.limit, 1, 1);
  const days = integer(body.days, DEFAULT_EVENT_LOOKBACK_DAYS, 1);
  if (skipHours === null || days === null || (body.limit !== undefined && limit === null)) return NextResponse.json({ success: false, error: "skipHours, days and limit must be valid integers" }, { status: 400 });
  const taskId = `event_search_${randomUUID()}`; const progressPath = progressPathForTask(taskId); mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
  writeProgress(progressPath, { taskId, total: 0, processed: 0, success: 0, failed: 0, currentInstitution: null, status: "starting" });
  const script = join(process.cwd(), "scripts", "ai-tasks", "search_news.ts"); const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(script) || !existsSync(tsxCli)) { const error = `Search script not found: ${script}`; markFailed(progressPath, taskId, error); return NextResponse.json({ success: false, error }, { status: 500 }); }
  const args = [tsxCli, script, "--skip-hours", String(skipHours), "--days", String(days), "--task-id", taskId]; if (limit !== null) args.push("--limit", String(limit)); if (body.force === true) args.push("--force");
  try {
    console.log(`[trigger-event-search:${taskId}] starting ${process.execPath} ${args.join(" ")}`);
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env: { ...process.env }, detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    if (!child.pid) {
      const error = "Event search process did not start (no child PID)";
      markFailed(progressPath, taskId, error);
      return NextResponse.json({ success: false, error }, { status: 500 });
    }
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => console.log(`[trigger-event-search:${taskId}] ${chunk.trimEnd()}`));
    child.stderr?.on("data", (chunk: string) => console.error(`[trigger-event-search:${taskId}:stderr] ${chunk.trimEnd()}`));
    child.once("spawn", () => console.log(`[trigger-event-search:${taskId}] child spawned pid=${child.pid}`));
    let spawnError = false;
    child.once("error", (error) => { spawnError = true; console.error(`[trigger-event-search:${taskId}]`, error); markFailed(progressPath, taskId, error instanceof Error ? error.message : String(error)); });
    child.once("exit", (code, signal) => { console.log(`[trigger-event-search:${taskId}] exited code=${code ?? "null"} signal=${signal ?? "none"}`); if (code !== 0 && !spawnError) markFailed(progressPath, taskId, `Event search exited with code ${code ?? "unknown"}`); });
    // Mark the task as running as soon as the child has a PID. The script will
    // replace this with the real totals before processing the first institution.
    markRunning(progressPath, taskId);
    child.unref();
  } catch (error) { const message = error instanceof Error ? error.message : String(error); markFailed(progressPath, taskId, message); return NextResponse.json({ success: false, error: message }, { status: 500 }); }
  return NextResponse.json({ status: "started", taskId }, { status: 202 });
}
