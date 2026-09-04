import { authenticate, cookieHeader, createSession } from "@/lib/auth";
import { getAuthDatabase, json } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const db = await getAuthDatabase();
  if (!db) return json({ error: "database_unconfigured" }, { status: 503 });
  let body: { email?: string; password?: string };
  try { body = await request.json() as { email?: string; password?: string }; } catch { return json({ error: "invalid_json" }, { status: 400 }); }
  if (typeof body.email !== "string" || typeof body.password !== "string" || body.password.length > 512) return json({ error: "invalid_credentials" }, { status: 401 });
  const user = await authenticate(body.email, body.password, db);
  if (!user) return json({ error: "invalid_credentials" }, { status: 401 });
  const session = await createSession(db, user.id, user.role);
  return json({ ok: true, user: { email: user.email, role: user.role } }, { headers: { "set-cookie": cookieHeader(session.cookie) } });
}
