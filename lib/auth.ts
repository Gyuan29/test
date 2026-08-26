import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "institution_session";
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ITERATIONS = 210_000;
export type UserRole = "admin" | "user";
export type AuthenticatedUser = { id: string; email: string; role: UserRole };

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function fromBase64(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export async function hashPassword(password: string, iterations = DEFAULT_ITERATIONS): Promise<string> {
  const salt = randomBytes(16);
  const digest = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  return `pbkdf2$sha256$${iterations}$${base64Url(salt)}$${base64Url(digest)}`;
}

function isEncodedPasswordHash(value: string): boolean {
  const parts = value.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 2_000_000) return false;
  try {
    return fromBase64(parts[3]).length > 0 && fromBase64(parts[4]).length > 0;
  } catch {
    return false;
  }
}

export async function verifyPasswordHash(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 2_000_000) return false;
  try {
    const expected = fromBase64(parts[4]);
    const actual = pbkdf2Sync(password, fromBase64(parts[3]), iterations, expected.length, "sha256");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function passwordConfig(): { email: string; encodedPassword: string } | null {
  const email = process.env.AUTH_EMAIL?.trim().toLowerCase();
  const configuredHash = process.env.AUTH_PASSWORD_HASH?.trim();
  const plain = process.env.AUTH_PASSWORD;
  if (!email || (!configuredHash && !plain)) return null;
  // Ignore stale/placeholder values such as AUTH_PASSWORD_HASH=AuthPasswordHash123.
  // A valid hash remains preferred; otherwise local development can use AUTH_PASSWORD.
  if (configuredHash && isEncodedPasswordHash(configuredHash)) return { email, encodedPassword: configuredHash };
  if (!plain) return null;
  const salt = Buffer.from("local-development-only-salt");
  const digest = pbkdf2Sync(plain ?? "", salt, 210_000, 32, "sha256");
  return { email, encodedPassword: `pbkdf2$sha256$210000$${base64Url(salt)}$${base64Url(digest)}` };
}

function secret(): string {
  const configured = process.env.AUTH_SESSION_SECRET?.trim() || process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (process.env.NODE_ENV === "production" && !configured) throw new Error("AUTH_SESSION_SECRET is required in production");
  return configured || "development-session-secret-change-me";
}

export async function signSessionCookie(token: string, signingSecret = secret()): Promise<string> {
  const signature = createHmac("sha256", signingSecret).update(token).digest("base64url");
  return `${token}.${signature}`;
}

export async function verifySessionCookie(value: string | null | undefined, signingSecret = secret()): Promise<string | null> {
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const token = value.slice(0, separator);
  const supplied = value.slice(separator + 1);
  const expected = createHmac("sha256", signingSecret).update(token).digest("base64url");
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  return token;
}

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function userIdForEmail(email: string): string {
  return `env-${createHash("sha256").update(email).digest("hex").slice(0, 32)}`;
}

export async function ensureConfiguredUser(db: D1Database): Promise<AuthenticatedUser | null> {
  const config = passwordConfig();
  if (!config) return null;
  const encodedPassword = config.encodedPassword;
  const parts = encodedPassword.split("$");
  if (parts.length !== 5) return null;
  const existing = await db.prepare("SELECT id, email, role FROM users WHERE email = ? LIMIT 1").bind(config.email).first<AuthenticatedUser>();
  console.log("[auth] configured user database role", { email: config.email, databaseRole: existing?.role ?? null });
  if (existing) {
    await db.prepare("UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?, role = 'admin', updated_at = ? WHERE id = ?")
      .bind(encodedPassword, parts[3], Number(parts[2]), new Date().toISOString(), existing.id).run();
    return { ...existing, role: "admin" };
  }
  const id = userIdForEmail(config.email);
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO users (id, email, password_hash, password_salt, password_iterations, role, updated_at)
    VALUES (?, ?, ?, ?, ?, 'admin', ?)
    ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash,
      password_salt = excluded.password_salt, password_iterations = excluded.password_iterations,
      role = 'admin', updated_at = excluded.updated_at`)
    .bind(id, config.email, encodedPassword, parts[3], Number(parts[2]), now).run();
  return (await db.prepare("SELECT id, email, role FROM users WHERE email = ? LIMIT 1").bind(config.email).first<AuthenticatedUser>()) ?? null;
}

export async function authenticate(email: string, password: string, db: D1Database): Promise<AuthenticatedUser | null> {
  const rawAuthEmail = process.env.AUTH_EMAIL;
  const configuredAdminEmail = rawAuthEmail?.trim().toLowerCase() || null;
  const config = passwordConfig();
  const normalizedEmail = email.trim().toLowerCase();
  const isConfiguredAdmin = Boolean(configuredAdminEmail && normalizedEmail === configuredAdminEmail);
  console.log("[auth] login environment", {
    AUTH_EMAIL: rawAuthEmail,
    AUTH_EMAIL_is_admin_example: rawAuthEmail?.trim().toLowerCase() === "admin@example.com",
    loginEmail: normalizedEmail,
    matchesAUTH_EMAIL: isConfiguredAdmin,
    passwordConfigLoaded: Boolean(config),
  });
  if (config && normalizedEmail === config.email) {
    if (!(await verifyPasswordHash(password, config.encodedPassword))) {
      console.log("[auth] configured administrator password verification failed", { email: normalizedEmail });
      return null;
    }
    const user = await ensureConfiguredUser(db);
    console.log("[auth] configured administrator login success", {
      databaseRole: user?.role ?? null,
      sessionUser: user ? { id: user.id, email: user.email, role: "admin" as const } : null,
    });
    return user ? { ...user, role: "admin" } : null;
  }
  const existing = await db.prepare("SELECT id, email, password_hash, role FROM users WHERE email = ? LIMIT 1").bind(normalizedEmail).first<AuthenticatedUser & { password_hash: string }>();
  if (!existing || !(await verifyPasswordHash(password, existing.password_hash))) return null;
  console.log("[auth] database user role before session", { email: existing.email, databaseRole: existing.role });
  const role: UserRole = isConfiguredAdmin ? "admin" : (existing.role === "admin" ? "admin" : "user");
  if (isConfiguredAdmin && existing.role !== "admin") {
    await db.prepare("UPDATE users SET role = 'admin', updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), existing.id).run();
    console.log("[auth] AUTH_EMAIL matched; forced database role to admin", { email: existing.email });
  }
  const sessionUser = { id: existing.id, email: existing.email, role };
  console.log("[auth] session user payload", sessionUser);
  return sessionUser;
}

export async function createSession(db: D1Database, userId: string, role: UserRole = "user"): Promise<{ cookie: string; expiresAt: string }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  console.log("[auth] writing session", { userId, role, expiresAt });
  try {
    await db.prepare("INSERT INTO sessions (id, user_id, token_hash, role, expires_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), userId, tokenHash, role, expiresAt).run();
  } catch (error) {
    // Keep deployments on the pre-role sessions schema usable until migrated.
    if (!/no such column: role|has no column named role/i.test(String(error))) throw error;
    await db.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)").bind(crypto.randomUUID(), userId, tokenHash, expiresAt).run();
  }
  return { cookie: await signSessionCookie(token), expiresAt };
}

export async function currentUser(request: Request, db: D1Database): Promise<AuthenticatedUser | null> {
  const signed = parseCookie(request.headers.get("cookie"), SESSION_COOKIE);
  const token = await verifySessionCookie(signed);
  if (!token) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  try {
    const row = await db.prepare("SELECT u.id, u.email, s.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? LIMIT 1").bind(tokenHash, new Date().toISOString()).first<AuthenticatedUser>();
    console.log("[auth] current session lookup", { found: Boolean(row), email: row?.email ?? null, role: row?.role ?? null });
    return row ? { ...row, role: row.role === "admin" ? "admin" : "user" } : null;
  } catch (error) {
    if (!/no such column: s\.role|no such column: role/i.test(String(error))) throw error;
    console.log("[auth] sessions.role unavailable; reading users.role compatibility path");
    const row = await db.prepare("SELECT u.id, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? LIMIT 1").bind(tokenHash, new Date().toISOString()).first<AuthenticatedUser>();
    console.log("[auth] current session compatibility lookup", { found: Boolean(row), email: row?.email ?? null, role: row?.role ?? null });
    return row ?? null;
  }
}

export async function requireUser(request: Request, db: D1Database): Promise<AuthenticatedUser | null> {
  return currentUser(request, db);
}

export function cookieHeader(value: string, maxAge = SESSION_TTL_MS / 1000): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

export async function revokeSession(request: Request, db: D1Database): Promise<void> {
  const signed = parseCookie(request.headers.get("cookie"), SESSION_COOKIE);
  const token = await verifySessionCookie(signed);
  if (!token) return;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?").bind(new Date().toISOString(), tokenHash).run();
}
