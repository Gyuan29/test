import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadLocalEnv(): void {
  const envPath = resolve(projectRoot, ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}

loadLocalEnv();
const email = process.env.AUTH_EMAIL?.trim().toLowerCase();
const password = process.env.AUTH_PASSWORD;
if (!email || !password) throw new Error(".env.local must contain AUTH_EMAIL and AUTH_PASSWORD");

const databasePath = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(projectRoot, ".local", "d1.sqlite");
if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
const client = createClient({ url: databasePath === ":memory:" ? "file::memory:" : `file:${databasePath}` });

const iterations = 210_000;
const salt = randomBytes(16);
const digest = pbkdf2Sync(password, salt, iterations, 32, "sha256");
const saltEncoded = salt.toString("base64url");
const encodedPassword = `pbkdf2$sha256$${iterations}$${saltEncoded}$${digest.toString("base64url")}`;
const userId = `env-${createHash("sha256").update(email).digest("hex").slice(0, 32)}`;

try {
  await client.execute({
    sql: `INSERT INTO users (id, email, password_hash, password_salt, password_iterations, role, updated_at)
      VALUES (?, ?, ?, ?, ?, 'admin', CURRENT_TIMESTAMP)
      ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash,
        password_salt = excluded.password_salt, password_iterations = excluded.password_iterations,
        role = 'admin',
        updated_at = excluded.updated_at`,
    args: [userId, email, encodedPassword, saltEncoded, iterations],
  });
  console.log(`Created or updated admin user ${email} in ${databasePath}`);
} catch (error) {
  if (/no such table|does not exist/i.test(String(error))) {
    throw new Error(`users table is missing in ${databasePath}; run npm run db:init first`);
  }
  throw error;
} finally {
  client.close();
}
