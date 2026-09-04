import { readdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProgressType = "search" | "event";
type ResetProgressBody = { type?: unknown };

const dataDir = resolve(process.cwd(), "data");
const progressFiles: Record<ProgressType, string> = {
  search: resolve(dataDir, "search_progress.json"),
  event: resolve(dataDir, "event_search_progress.json"),
};

async function eventProgressFiles(): Promise<string[]> {
  let files: string[] = [];
  try { files = await readdir(dataDir); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return files
    .filter((file) => /^event_search_progress(?:_[a-zA-Z0-9._-]+)?\.json$/.test(file))
    .map((file) => resolve(dataDir, file));
}

export async function POST(request: NextRequest) {
  const denied = await requireAdmin(request);
  if (denied) return denied;

  const body = await request.json().catch(() => null) as ResetProgressBody | null;
  const type = body && typeof body === "object" ? body.type : undefined;
  if (type !== "search" && type !== "event") {
    return NextResponse.json({ success: false, error: "type must be search or event" }, { status: 400 });
  }

  try {
    const targets = type === "event" ? await eventProgressFiles() : [progressFiles[type]];
    await Promise.all(targets.map(async (target) => {
      try { await unlink(target); } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }));
  } catch (error) {
    console.error(`[reset-progress:${type}] failed to remove progress file`, error);
    return NextResponse.json({ success: false, error: "Unable to reset progress" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
