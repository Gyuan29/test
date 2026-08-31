import { currentUser } from "@/lib/auth";
import { getDatabase, json } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const db = await getDatabase();
  if (!db) return json({ error: "database_unconfigured" }, { status: 503 });
  const user = await currentUser(request, db);
  if (!user) return json({ error: "authentication_required" }, { status: 401 });
  const { id } = await context.params;
  const sessionId = id.trim();
  if (!sessionId || sessionId.length > 200) return json({ error: "invalid_session_id" }, { status: 400 });
  const now = new Date().toISOString();
  const result = await db.prepare("UPDATE chat_sessions SET revoked_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(now, now, sessionId, user.id).run();
  return json({ ok: true, sessionId, deleted: result.success });
}
