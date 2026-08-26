import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const progressPath = `${process.cwd()}/data/event_search_progress.json`;
export async function GET(request: NextRequest) {
  const denied = await requireAdmin(request); if (denied) return denied;
  if (!existsSync(progressPath)) return NextResponse.json({ taskId: null, total: 0, processed: 0, success: 0, failed: 0, currentInstitution: null, status: "completed", lastUpdated: new Date().toISOString() });
  try { return NextResponse.json(JSON.parse(await readFile(progressPath, "utf8")), { headers: { "cache-control": "no-store" } }); } catch { return NextResponse.json({ success: false, error: "Unable to read event search progress" }, { status: 500 }); }
}
