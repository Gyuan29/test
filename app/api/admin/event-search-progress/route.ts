import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const dataDir = resolve(process.cwd(), "data");
const legacyProgressPath = resolve(dataDir, "event_search_progress.json");
function safeTaskId(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96) || "default"; }
function progressPathForTask(taskId: string): string { return resolve(dataDir, `event_search_progress_${safeTaskId(taskId)}.json`); }
function latestProgressPath(): string | null {
  if (!existsSync(dataDir)) return existsSync(legacyProgressPath) ? legacyProgressPath : null;
  const files = readdirSync(dataDir).filter((file) => /^event_search_progress_[a-zA-Z0-9._-]+\.json$/.test(file));
  if (!files.length) return existsSync(legacyProgressPath) ? legacyProgressPath : null;
  const candidates = files.flatMap((file) => {
    const path = resolve(dataDir, file);
    try { return [{ path, modifiedAt: statSync(path).mtimeMs }]; } catch { return []; }
  });
  return candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.path || null;
}
export async function GET(request: NextRequest) {
  const denied = await requireAdmin(request); if (denied) return denied;
  const taskId = request.nextUrl.searchParams.get("taskId")?.trim();
  const progressPath = taskId ? progressPathForTask(taskId) : latestProgressPath();
  if (!progressPath) return NextResponse.json({ taskId: null, total: 0, processed: 0, success: 0, failed: 0, currentInstitution: null, status: "completed", lastUpdated: new Date().toISOString() });
  if (!existsSync(progressPath)) return NextResponse.json({ taskId: null, total: 0, processed: 0, success: 0, failed: 0, currentInstitution: null, status: "completed", lastUpdated: new Date().toISOString() });
  try { return NextResponse.json(JSON.parse(await readFile(progressPath, "utf8")), { headers: { "cache-control": "no-store" } }); } catch { return NextResponse.json({ success: false, error: "Unable to read event search progress" }, { status: 500 }); }
}
