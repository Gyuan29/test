import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TriggerBody = { skipHours?: unknown; limit?: unknown; force?: unknown };

function positiveOrZero(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function markTaskFailed(progressPath: string, taskId: string, message: string): void {
  try {
    const current = existsSync(progressPath) ? JSON.parse(readFileSync(progressPath, "utf8")) as Record<string, unknown> : {};
    if (current.taskId && current.taskId !== taskId) return;
    writeFileSync(progressPath, `${JSON.stringify({ ...current, taskId, status: "failed", message, lastUpdated: new Date().toISOString() }, null, 2)}\n`, "utf8");
  } catch (error) { console.error(`[trigger-search:${taskId}] failed to write failure progress`, error); }
}

export async function POST(request: NextRequest) {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({})) as TriggerBody;
  const skipHours = positiveOrZero(body.skipHours, 24);
  const limit = body.limit === undefined ? null : positiveOrZero(body.limit, 0);
  if (skipHours === null || (body.limit !== undefined && limit === null)) {
    return NextResponse.json({ success: false, error: "skipHours and limit must be non-negative integers" }, { status: 400 });
  }

  const taskId = `search_${randomUUID()}`;
  const progressPath = resolve(process.cwd(), "data", "search_progress.json");
  mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
  writeFileSync(progressPath, `${JSON.stringify({ taskId, total: 0, processed: 0, success: 0, failed: 0, currentInstitution: null, status: "starting", lastUpdated: new Date().toISOString() }, null, 2)}\n`, "utf8");
  const args = ["scripts/data-pipeline/discover_sources.ts", "--searxng", "--skip-hours", String(skipHours), "--task-id", taskId];
  if (limit !== null) args.push("--limit", String(limit));
  if (body.force === true) args.push("--force");

  const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(tsxCli)) {
    const error = `tsx CLI not found: ${tsxCli}`;
    markTaskFailed(progressPath, taskId, error);
    return NextResponse.json({ success: false, error }, { status: 500 });
  }
  const executable = process.execPath;
  const spawnArgs = [tsxCli, ...args];
  try {
    const child = spawn(executable, spawnArgs, {
      cwd: process.cwd(),
      env: { ...process.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (!child.pid) {
      const error = "Search process did not start (no child PID)";
      markTaskFailed(progressPath, taskId, error);
      return NextResponse.json({ success: false, error }, { status: 500 });
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => console.log(`[trigger-search:${taskId}] ${chunk.trimEnd()}`));
    child.stderr?.on("data", (chunk: string) => console.error(`[trigger-search:${taskId}:stderr] ${chunk.trimEnd()}`));
    child.once("exit", (code, signal) => {
      console.log(`[trigger-search:${taskId}] exited code=${code ?? "null"} signal=${signal ?? "none"}`);
      if (code !== 0) markTaskFailed(progressPath, taskId, `Search process exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`);
    });
    child.once("error", (error) => {
      console.error(`[trigger-search:${taskId}]`, error);
      markTaskFailed(progressPath, taskId, error instanceof Error ? error.message : String(error));
    });
    child.unref();
  } catch (error) {
    console.error(`[trigger-search:${taskId}] failed to spawn`, error);
    const message = error instanceof Error ? error.message : String(error);
    markTaskFailed(progressPath, taskId, message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }

  return NextResponse.json({ status: "started", taskId }, { status: 202 });
}
