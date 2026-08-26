import { defineConfig } from "drizzle-kit";

const localDatabaseUrl = process.env.LOCAL_SQLITE_PATH?.trim() || "./.local/d1.sqlite";

export default defineConfig({
  out: "./drizzle",
  schema: "./db/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    // Override with LOCAL_SQLITE_PATH when pointing at a Wrangler/D1 export.
    url: localDatabaseUrl,
  },
  migrations: {
    table: "__drizzle_migrations",
  },
});
