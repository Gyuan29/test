import { cookieHeader, revokeSession } from "@/lib/auth";
import { getAuthDatabase, json } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const db = await getAuthDatabase();
  if (db) await revokeSession(request, db);
  return json({ ok: true }, { headers: { "set-cookie": cookieHeader("", 0) } });
}
