import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const currentTimestamp = () => sql`CURRENT_TIMESTAMP`;

export const organizations = sqliteTable(
  "organizations",
  {
    entityId: text("entity_id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    entityType: text("entity_type").notNull(),
    isCoreTracking: integer("is_core_tracking", { mode: "boolean" })
      .notNull()
      .default(false),
    region: text("region").notNull(),
    country: text("country").notNull(),
    founded: text("founded"),
    analysisType: text("analysis_type"),
    relatedTypes: text("related_types"),
    mentionCount: integer("mention_count").notNull().default(1),
    credibilityScore: integer("credibility_score"),
    source: text("source"),
    sourceCount: integer("source_count").notNull().default(0),
    context: text("context"),
    sourceLocation: text("source_location"),
    sourceDocument: text("source_document"),
    originalName: text("original_name"),
    locationBasis: text("location_basis"),
    locationConfidence: text("location_confidence"),
    summary: text("summary"),
    websiteUrl: text("website_url"),

    // Version A fields
    sources: text("sources").notNull().default("[]"),
    lastSearchedAt: text("last_searched_at"),
    searchStatus: text("search_status", {
      enum: ["pending", "success", "failed"],
    })
      .notNull()
      .default("pending"),
    lastEventSearchedAt: text("last_event_searched_at"),
    eventSearchStatus: text("event_search_status", {
      enum: ["pending", "success", "failed"],
    })
      .notNull()
      .default("pending"),

    createdAt: text("created_at").notNull().default(currentTimestamp()),
    updatedAt: text("updated_at").notNull().default(currentTimestamp()),
  },
  (table) => ({
    slugUnique: uniqueIndex("organizations_slug_uq").on(table.slug),
    nameIdx: index("idx_organizations_name").on(table.name),
    typeRegionIdx: index("organizations_type_region_idx").on(
      table.entityType,
      table.region,
    ),
    credibilityIdx: index("organizations_credibility_idx").on(
      table.credibilityScore,
    ),

    // Version A scheduling indexes
    searchScheduleIdx: index("organizations_search_schedule_idx").on(
      table.searchStatus,
      table.lastSearchedAt,
    ),
    eventSearchScheduleIdx: index(
      "organizations_event_search_schedule_idx",
    ).on(table.eventSearchStatus, table.lastEventSearchedAt),
  }),
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.entityId, { onDelete: "cascade" }),
    eventDate: text("event_date").notNull(),
    eventType: text("event_type"),

    // Version A field
    relevanceScore: integer("relevance_score"),

    title: text("title").notNull(),
    summary: text("summary"),
    translatedTitle: text("translated_title"),
    translatedDescription: text("translated_description"),
    sourceUrl: text("source_url"),
    sourceName: text("source_name"),
    createdAt: text("created_at").notNull().default(currentTimestamp()),
  },
  (table) => ({
    orgDateIdx: index("events_org_date_idx").on(
      table.organizationId,
      table.eventDate,
    ),
  }),
);

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    passwordSalt: text("password_salt").notNull(),
    passwordIterations: integer("password_iterations").notNull(),
    role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: text("locked_until"),
    createdAt: text("created_at").notNull().default(currentTimestamp()),
    updatedAt: text("updated_at").notNull().default(currentTimestamp()),
  },
  (table) => ({ emailUnique: uniqueIndex("users_email_uq").on(table.email) }),
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(currentTimestamp()),
  },
  (table) => ({ tokenUnique: uniqueIndex("sessions_token_hash_uq").on(table.tokenHash) }),
);

export const userProviderSettings = sqliteTable(
  "user_provider_settings",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model"),
    baseUrl: text("base_url"),
    credentialCiphertext: text("credential_ciphertext"),
    credentialNonce: text("credential_nonce"),
    createdAt: text("created_at").notNull().default(currentTimestamp()),
    updatedAt: text("updated_at").notNull().default(currentTimestamp()),
  },
  (table) => ({
    userProviderUnique: uniqueIndex("user_provider_uq").on(table.userId, table.provider),
  }),
);

export const chatSessions = sqliteTable(
  "chat_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").references(() => organizations.entityId, { onDelete: "set null" }),
    title: text("title"),
    messagesJson: text("messages_json").notNull().default("[]"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(currentTimestamp()),
    updatedAt: text("updated_at").notNull().default(currentTimestamp()),
  },
  (table) => ({
    sessionTimeIdx: index("chat_session_time_idx").on(table.userId, table.updatedAt),
  }),
);

export const newsSources = sqliteTable(
  "news_sources",
  {
    id: text("id").primaryKey(),
    organizationSlug: text("organization_slug").notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    intervalMinutes: integer("interval_minutes").notNull().default(1440),
    etag: text("etag"),
    lastModified: text("last_modified"),
    lastContentHash: text("last_content_hash"),
    failureCount: integer("failure_count").notNull().default(0),
    lastFetchStatus: text("last_fetch_status"),
    retryClass: text("retry_class"),
    lastCheckedAt: text("last_checked_at"),
    nextCheckAt: text("next_check_at"),
    nextRetryAt: text("next_retry_at"),
  },
  (table) => ({
    organizationIdx: index("news_sources_organization_idx").on(table.organizationSlug),
    statusIdx: index("news_sources_status_idx").on(table.retryClass, table.lastFetchStatus),
  }),
);

export type Organization = typeof organizations.$inferSelect;
export type Event = typeof events.$inferSelect;
export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type ChatSession = typeof chatSessions.$inferSelect;
export type NewsSource = typeof newsSources.$inferSelect;
