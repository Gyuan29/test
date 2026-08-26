import { hashPassword, createSession, cookieHeader } from "@/lib/auth";
import { getDatabase, json } from "@/lib/db";

export const runtime = "nodejs";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request): Promise<Response> {
  const db = await getDatabase();
  if (!db) return json({ error: "database_unconfigured" }, { status: 503 });

  let body: { email?: unknown; password?: unknown };
  try {
    body = await request.json() as { email?: unknown; password?: unknown };
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!EMAIL_PATTERN.test(email) || email.length > 320) return json({ error: "invalid_email" }, { status: 400 });
  if (password.length < 6 || password.length > 512) return json({ error: "password_too_short_or_long" }, { status: 400 });

  const existing = await db.prepare("SELECT id FROM users WHERE email = ? LIMIT 1").bind(email).first<{ id: string }>();
  if (existing) return json({ error: "email_already_registered" }, { status: 409 });

  const encodedPassword = await hashPassword(password);
  const parts = encodedPassword.split("$");
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await db.prepare(`INSERT INTO users (id, email, password_hash, password_salt, password_iterations, role, updated_at)
      VALUES (?, ?, ?, ?, ?, 'user', ?)`)
      .bind(userId, email, encodedPassword, parts[3], Number(parts[2]), now).run();
  } catch (error) {
    if (/unique|constraint/i.test(String(error))) return json({ error: "email_already_registered" }, { status: 409 });
    throw error;
  }

  const session = await createSession(db, userId, "user");
  return json(
    { ok: true, user: { id: userId, email, role: "user" } },
    { status: 201, headers: { "set-cookie": cookieHeader(session.cookie) } },
  );
}
