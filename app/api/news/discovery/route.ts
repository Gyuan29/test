import { getAuthDatabase, json } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { getDatabase } from "@/lib/db";

type DiscoveryResult = {
  status?: string;
  entityName?: string;
  error?: string;
};

/** Compatibility boundary for the local discovery scheduler. */
export async function GET(request: Request) {
  const db = await getDatabase();
  if (!db) return json({ error: "database_unconfigured" }, { status: 503 });
  const authDb = await getAuthDatabase();
  if (!authDb || !(await currentUser(request, authDb))) return json({ error: "authentication_required" }, { status: 401 });
  return json({ status: "idle", running: false, results: [], implementation: "discovery_not_configured" });
}

export async function POST(request: Request) {
  const db = await getDatabase();
  if (!db) return json({ error: "database_unconfigured" }, { status: 503 });
  const authDb = await getAuthDatabase();
  if (!authDb || !(await currentUser(request, authDb))) return json({ error: "authentication_required" }, { status: 401 });
  let body: { results?: DiscoveryResult[] } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }
  return json({ accepted: body.results?.length ?? 0, implementation: "discovery_not_configured" }, { status: 202 });
}

export async function PUT(request: Request) {
  const db = await getDatabase();
  if (!db) return json({ error: "database_unconfigured" }, { status: 503 });
  const authDb = await getAuthDatabase();
  if (!authDb || !(await currentUser(request, authDb))) return json({ error: "authentication_required" }, { status: 401 });
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }
  return json({ recorded: false, received: Object.keys(body), implementation: "discovery_not_configured" });
}
