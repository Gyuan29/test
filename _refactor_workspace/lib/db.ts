import type { ChatSession, Event, Organization } from "@/db/schema";
import { normalizeEventDate, normalizeEventDescription, normalizeEventTitle } from "@/lib/event-display";

type SqlValue = string | number | null;

type LocalSqliteClient = {
  execute(request: { sql: string; args?: SqlValue[] }): Promise<{ rows: Array<Record<string, unknown>> }>;
  executeMultiple(sql: string): Promise<void>;
};

const LOCAL_SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS organizations (
    entity_id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    entity_type TEXT NOT NULL,
    is_core_tracking INTEGER NOT NULL DEFAULT 0,
    region TEXT NOT NULL,
    country TEXT NOT NULL,
    founded TEXT,
    analysis_type TEXT,
    related_types TEXT,
    mention_count INTEGER NOT NULL DEFAULT 1,
    credibility_score INTEGER,
    source TEXT,
    source_count INTEGER NOT NULL DEFAULT 0,
    context TEXT,
    source_location TEXT,
    source_document TEXT,
    original_name TEXT,
    location_basis TEXT,
    location_confidence TEXT,
    summary TEXT,
    website_url TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_organizations_name ON organizations(name);
  CREATE INDEX IF NOT EXISTS idx_organizations_description ON organizations(description);
  CREATE INDEX IF NOT EXISTS idx_organizations_summary ON organizations(summary);
  CREATE INDEX IF NOT EXISTS idx_organizations_context ON organizations(context);
  CREATE INDEX IF NOT EXISTS organizations_type_region_idx ON organizations(entity_type, region);
  CREATE INDEX IF NOT EXISTS organizations_credibility_idx ON organizations(credibility_score);

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(entity_id) ON DELETE CASCADE,
    event_date TEXT NOT NULL,
    event_type TEXT,
    title TEXT NOT NULL,
    summary TEXT,
    translated_title TEXT,
    translated_description TEXT,
    source_url TEXT,
    canonical_source_url TEXT,
    source_name TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS events_org_date_idx ON events(organization_id, event_date);
  CREATE UNIQUE INDEX IF NOT EXISTS events_organization_canonical_source_uq ON events(organization_id, canonical_source_url);

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_iterations INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    failed_login_count INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS sessions_user_expiry_idx ON sessions(user_id, expires_at);

  CREATE TABLE IF NOT EXISTS user_provider_settings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model TEXT,
    base_url TEXT,
    credential_ciphertext TEXT,
    credential_nonce TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, provider)
  );

  CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id TEXT REFERENCES organizations(entity_id) ON DELETE SET NULL,
    title TEXT,
    messages_json TEXT NOT NULL DEFAULT '[]',
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS chat_session_time_idx ON chat_sessions(user_id, updated_at);

  CREATE TABLE IF NOT EXISTS news_sources (
    id TEXT PRIMARY KEY,
    organization_slug TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    interval_minutes INTEGER NOT NULL DEFAULT 1440,
    etag TEXT,
    last_modified TEXT,
    last_content_hash TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_fetch_status TEXT,
    retry_class TEXT,
    last_checked_at TEXT,
    next_check_at TEXT,
    next_retry_at TEXT
  );
  CREATE INDEX IF NOT EXISTS news_sources_organization_idx ON news_sources(organization_slug);
  CREATE INDEX IF NOT EXISTS news_sources_status_idx ON news_sources(retry_class, last_fetch_status);

  CREATE TABLE IF NOT EXISTS briefing_runs (
    id TEXT PRIMARY KEY,
    window_start TEXT NOT NULL,
    window_end TEXT NOT NULL,
    event_count INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'generated', 'pushed', 'failed', 'skipped')),
    generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    pushed_at TEXT,
    error TEXT,
    UNIQUE (window_start, window_end, content_hash)
  );
  CREATE INDEX IF NOT EXISTS briefing_runs_window_idx ON briefing_runs(window_start, window_end);

`;

class LocalPreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly database: LocalSqliteClient,
    private readonly query: string,
    private readonly values: SqlValue[] = [],
  ) {}

  bind(...values: SqlValue[]): D1PreparedStatement {
    return new LocalPreparedStatement(this.database, this.query, values);
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = await this.database.execute({ sql: this.query, args: this.values });
    const results = result.rows as T[];
    return { results, success: true };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const result = await this.database.execute({ sql: this.query, args: this.values });
    return (result.rows[0] as T | undefined) ?? null;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    await this.database.execute({ sql: this.query, args: this.values });
    return { results: [], success: true };
  }
}

class LocalDatabase implements D1Database {
  constructor(private readonly database: LocalSqliteClient) {}

  prepare(query: string): D1PreparedStatement {
    return new LocalPreparedStatement(this.database, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<T[]> {
    return Promise.all(statements.map((statement) => statement.run() as Promise<T>));
  }
}

let localDatabase: Promise<D1Database> | undefined;
let workerDatabase: D1Database | null | undefined;

function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && Boolean(process.versions?.node);
}

async function createLocalDatabase(): Promise<D1Database> {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const path = process.env.LOCAL_SQLITE_PATH?.trim() || ":memory:";
  const url = path === ":memory:" ? "file::memory:" : `file:${path}`;
  const client = createClient({ url });
  await client.executeMultiple(LOCAL_SCHEMA);
  const userColumns = await client.execute({ sql: "PRAGMA table_info(users)" });
  if (!userColumns.rows.some((column) => column.name === "role")) {
    await client.execute({ sql: "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user'))" });
  }
  const sessionColumns = await client.execute({ sql: "PRAGMA table_info(sessions)" });
  if (!sessionColumns.rows.some((column) => column.name === "role")) {
    await client.execute({ sql: "ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user'))" });
  }
  // Initialize the official Drizzle LibSQL adapter so callers can share the
  // same client without bringing back a native SQLite driver.
  drizzle(client);
  return new LocalDatabase(client);
}

/** Set the D1 binding from the Worker entry point without importing Cloudflare-only modules locally. */
export function setWorkerDatabase(database: D1Database | undefined): void {
  workerDatabase = database ?? null;
}

/** Resolve local SQLite in Node and the injected D1 binding in a Worker runtime. */
export async function getDatabase(): Promise<D1Database | null> {
  if (isNodeRuntime()) {
    localDatabase ??= createLocalDatabase();
    return localDatabase;
  }
  return workerDatabase ?? null;
}

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, {
    headers: { "cache-control": "no-store", ...(init?.headers ?? {}) },
    ...init,
  });
}

export function isMissingTable(error: unknown): boolean {
  return /no such table|does not exist/i.test(error instanceof Error ? error.message : String(error));
}

export type OrganizationRow = Record<string, unknown> & {
  entity_id: string;
  slug: string;
  name: string;
  description?: string | null;
  entity_type: string;
  is_core_tracking: number | boolean;
  region: string;
  country: string;
  founded?: string | null;
  analysis_type?: string | null;
  related_types?: string | null;
  mention_count?: number | null;
  credibility_score?: number | null;
  source?: string | null;
  source_count?: number | null;
  context?: string | null;
  source_location?: string | null;
  source_document?: string | null;
  original_name?: string | null;
  location_basis?: string | null;
  location_confidence?: string | null;
  summary?: string | null;
  website_url?: string | null;
  sources?: string | null;
  last_searched_at?: string | null;
  search_status?: string | null;
  last_event_searched_at?: string | null;
  event_search_status?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type EventRow = Record<string, unknown> & {
  id: string;
  organization_id: string;
  event_date: string;
  event_type?: string | null;
  relevance_score?: number | null;
  title: string;
  summary?: string | null;
  translated_title?: string | null;
  translated_description?: string | null;
  source_url?: string | null;
  canonical_source_url?: string | null;
  source_name?: string | null;
  created_at?: string | null;
};

export function mapOrganization(row: OrganizationRow): Organization {
  return {
    entityId: row.entity_id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    credibilityScore: row.credibility_score ?? null,
    source: row.source ?? null,
    sourceCount: row.source_count ?? 0,
    entityType: row.entity_type,
    isCoreTracking: Boolean(row.is_core_tracking),
    region: row.region,
    country: row.country,
    founded: row.founded ?? null,
    analysisType: row.analysis_type ?? null,
    relatedTypes: row.related_types ?? null,
    mentionCount: row.mention_count ?? 1,
    context: row.context ?? null,
    sourceLocation: row.source_location ?? null,
    sourceDocument: row.source_document ?? null,
    originalName: row.original_name ?? null,
    locationBasis: row.location_basis ?? null,
    locationConfidence: row.location_confidence ?? null,
    summary: row.summary ?? null,
    websiteUrl: row.website_url ?? null,
    sources: row.sources ?? "[]",
    lastSearchedAt: row.last_searched_at ?? null,
    searchStatus: row.search_status === "success" || row.search_status === "failed" ? row.search_status : "pending",
    lastEventSearchedAt: row.last_event_searched_at ?? null,
    eventSearchStatus: row.event_search_status === "success" || row.event_search_status === "failed" ? row.event_search_status : "pending",
    createdAt: row.created_at ?? "",
    updatedAt: row.updated_at ?? "",
  };
}

export function mapEvent(row: EventRow): Event {
  const title = normalizeEventTitle(row.title);
  const descriptionFallback = row.summary ?? title;
  return {
    id: row.id,
    organizationId: row.organization_id,
    eventDate: normalizeEventDate(row.event_date) ?? "unknown",
    eventType: row.event_type ?? null,
    relevanceScore: row.relevance_score == null ? null : Number(row.relevance_score),
    title,
    summary: row.summary ?? null,
    translatedTitle: row.translated_title == null ? null : normalizeEventTitle(row.translated_title, title),
    translatedDescription: row.translated_description == null ? null : normalizeEventDescription(row.translated_description, descriptionFallback),
    sourceUrl: row.source_url ?? null,
    canonicalSourceUrl: row.canonical_source_url ?? null,
    sourceName: row.source_name ?? null,
    createdAt: row.created_at ?? "",
  };
}

export function mapChatSession(row: Record<string, unknown>): ChatSession {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    organizationId: row.organization_id == null ? null : String(row.organization_id),
    title: row.title == null ? null : String(row.title),
    messagesJson: String(row.messages_json ?? "[]"),
    revokedAt: row.revoked_at == null ? null : String(row.revoked_at),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}
