import { cookieHeader, revokeSession } from "@/lib/auth";
import { getDatabase, json } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const db = await getDatabase();
  if (db) await revokeSession(request, db);
  return json({ ok: true }, { headers: { "set-cookie": cookieHeader("", 0) } });
}

