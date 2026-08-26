import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const progressPath = `${process.cwd()}/data/search_progress.json`;

export async function GET(request: NextRequest) {
  const denied = await requireAdmin(request); if (denied) return denied;
  if (!existsSync(progressPath)) return NextResponse.json({ taskId: null, total: 0, processed: 0, success: 0, failed: 0, currentInstitution: null, status: "completed", lastUpdated: new Date().toISOString() });
  try {
    const body = JSON.parse(await readFile(progressPath, "utf8")) as Record<string, unknown>;
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ success: false, error: "Unable to read search progress" }, { status: 500 });
  }
}
