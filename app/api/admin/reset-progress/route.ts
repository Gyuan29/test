import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProgressType = "search" | "event";
type ResetProgressBody = { type?: unknown };

const progressFiles: Record<ProgressType, string> = {
  search: resolve(process.cwd(), "data", "search_progress.json"),
  event: resolve(process.cwd(), "data", "event_search_progress.json"),
};

export async function POST(request: NextRequest) {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const body = await request.json().catch(() => null) as ResetProgressBody | null;
  const type = body && typeof body === "object" ? body.type : undefined;
  if (type !== "search" && type !== "event") {
    return NextResponse.json({ success: false, error: "type must be search or event" }, { status: 400 });
  }

  try {
    await unlink(progressFiles[type]);
  } catch (error) {
    // A missing progress file already represents a reset state.
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      console.error(`[reset-progress:${type}] failed to remove progress file`, error);
      return NextResponse.json({ success: false, error: "Unable to reset progress" }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true });
}
