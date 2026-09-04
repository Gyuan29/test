import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createClient } from "@libsql/client";

const projectRoot = resolve(import.meta.dirname, "../..");
const sourcePath = resolve(projectRoot, process.env.LOCAL_SQLITE_PATH?.trim() || ".local/d1.sqlite");
const targetPath = resolve(projectRoot, process.env.LOCAL_AUTH_SQLITE_PATH?.trim() || ".local/auth.sqlite");

function timestamp(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

async function main(): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const backupPath = `${sourcePath}.before-auth-migration.${timestamp()}`;
  await copyFile(sourcePath, backupPath);
  console.log(`Backed up source database to ${backupPath}`);

  const source = createClient({ url: `file:${sourcePath}` });
  const target = createClient({ url: `file:${targetPath}` });
  const schema = `
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL, password_iterations INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', failed_login_count INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'user',
      expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS user_provider_settings (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, model TEXT, base_url TEXT, credential_ciphertext TEXT,
      credential_nonce TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE (user_id, provider)
    );
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_id TEXT, title TEXT, messages_json TEXT NOT NULL DEFAULT '[]',
      revoked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS sessions_user_expiry_idx ON sessions(user_id, expires_at);
    CREATE INDEX IF NOT EXISTS chat_session_time_idx ON chat_sessions(user_id, updated_at);
  `;
  await target.executeMultiple(schema);
  const targetUsers = await target.execute({ sql: "PRAGMA table_info(users)" });
  if (!targetUsers.rows.some((column) => column.name === "role")) {
    await target.execute({ sql: "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'" });
  }
  const targetSessions = await target.execute({ sql: "PRAGMA table_info(sessions)" });
  if (!targetSessions.rows.some((column) => column.name === "role")) {
    await target.execute({ sql: "ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'user'" });
  }
  await target.execute({ sql: "BEGIN" });
  try {
    const users = await source.execute({ sql: "SELECT id,email,password_hash,password_salt,password_iterations,role,failed_login_count,locked_until,created_at,updated_at FROM users" });
    for (const row of users.rows) {
      await target.execute({ sql: `INSERT OR IGNORE INTO users (id,email,password_hash,password_salt,password_iterations,role,failed_login_count,locked_until,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, args: [row.id, row.email, row.password_hash, row.password_salt, row.password_iterations, row.role ?? "user", row.failed_login_count ?? 0, row.locked_until ?? null, row.created_at, row.updated_at] });
    }
    const sessions = await source.execute({ sql: "SELECT id,user_id,token_hash,role,expires_at,revoked_at,created_at FROM sessions" });
    for (const row of sessions.rows) {
      await target.execute({ sql: "INSERT OR IGNORE INTO sessions (id,user_id,token_hash,role,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,?)", args: [row.id, row.user_id, row.token_hash, row.role ?? "user", row.expires_at, row.revoked_at ?? null, row.created_at] });
    }
    const settings = await source.execute({ sql: "SELECT id,user_id,provider,model,base_url,credential_ciphertext,credential_nonce,created_at,updated_at FROM user_provider_settings" });
    for (const row of settings.rows) {
      await target.execute({ sql: "INSERT OR IGNORE INTO user_provider_settings (id,user_id,provider,model,base_url,credential_ciphertext,credential_nonce,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", args: [row.id, row.user_id, row.provider, row.model ?? null, row.base_url ?? null, row.credential_ciphertext ?? null, row.credential_nonce ?? null, row.created_at, row.updated_at] });
    }
    const chats = await source.execute({ sql: "SELECT id,user_id,organization_id,title,messages_json,revoked_at,created_at,updated_at FROM chat_sessions" });
    for (const row of chats.rows) {
      await target.execute({ sql: "INSERT OR IGNORE INTO chat_sessions (id,user_id,organization_id,title,messages_json,revoked_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", args: [row.id, row.user_id, row.organization_id ?? null, row.title ?? null, row.messages_json ?? "[]", row.revoked_at ?? null, row.created_at, row.updated_at] });
    }
    await target.execute({ sql: "COMMIT" });
    console.log(`Migrated users=${users.rows.length}, sessions=${sessions.rows.length}, provider_settings=${settings.rows.length}, chat_sessions=${chats.rows.length}`);
  } catch (error) {
    await target.execute({ sql: "ROLLBACK" }).catch(() => undefined);
    throw error;
  } finally {
    source.close();
    target.close();
  }
}

main().catch((error) => { console.error("Auth database migration failed:", error); process.exitCode = 1; });
