import { NextResponse } from "next/server";
import { currentUser, type AuthenticatedUser } from "@/lib/auth";
import { getDatabase } from "@/lib/db";

export type AdminRole = "admin";

export async function getAdminUser(request: Request): Promise<AuthenticatedUser | null> {
  const db = await getDatabase();
  if (!db) {
    console.log("[admin-auth] requireAdmin database unavailable");
    return null;
  }
  const user = await currentUser(request, db);
  if (!user) {
    console.log("[admin-auth] requireAdmin has no valid current session user");
    return null;
  }
  console.log("[admin-auth] current session user", { email: user.email, role: user.role });
  if (user.role === "admin") return user;
  // Environment-configured administrator remains a recovery path for legacy
  // sessions that were created before roles were persisted in the session.
  const configuredEmail = process.env.AUTH_EMAIL?.trim().toLowerCase();
  const matchesConfiguredAdmin = Boolean(configuredEmail && user.email.trim().toLowerCase() === configuredEmail);
  console.log("[admin-auth] AUTH_EMAIL fallback check", { configuredEmail, matchesConfiguredAdmin });
  return matchesConfiguredAdmin ? { ...user, role: "admin" } : null;
}

export async function getAdminRole(request: Request): Promise<AdminRole | null> {
  return (await getAdminUser(request)) ? "admin" : null;
}

/** Server-side authorization for every management endpoint. */
export async function requireAdmin(request: Request): Promise<NextResponse | null> {
  const adminUser = await getAdminUser(request);
  console.log("[admin-auth] requireAdmin result", {
    allowed: Boolean(adminUser),
    email: adminUser?.email ?? null,
    role: adminUser?.role ?? null,
  });
  if (adminUser) return null;
  return NextResponse.json({ success: false, error: "Admin authorization required" }, { status: 403 });
}
