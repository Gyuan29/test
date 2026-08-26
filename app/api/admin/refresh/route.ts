import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Job = { id: string; status: "queued" | "running" | "completed" | "failed"; startedAt: string; finishedAt?: string; error?: string };
const jobs = new Map<string, Job>();

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", command, ...args], { cwd: process.cwd(), env: process.env, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code ?? "unknown"}`)));
  });
}

export async function POST(request: NextRequest) {
  const denied = await requireAdmin(request); if (denied) return denied;
  const id = `refresh_${randomUUID()}`;
  const job: Job = { id, status: "queued", startedAt: new Date().toISOString() };
  jobs.set(id, job);
  void (async () => {
    job.status = "running";
    try {
      await run("scripts/data-pipeline/discover_sources.ts", ["--searxng", "--limit", "1"]);
      await run("scripts/ai-tasks/enrich_data.ts", ["--limit", "1"]);
      job.status = "completed";
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  })();
  return NextResponse.json({ success: true, data: job }, { status: 202 });
}

export async function GET(request: NextRequest) {
  const denied = await requireAdmin(request); if (denied) return denied;
  const id = new URL(request.url).searchParams.get("jobId") || "";
  const job = jobs.get(id);
  if (!job) return NextResponse.json({ success: false, error: "Job not found" }, { status: 404 });
  return NextResponse.json({ success: true, data: job });
}
