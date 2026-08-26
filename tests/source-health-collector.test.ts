import assert from "node:assert/strict";
import test from "node:test";
import { collectLatestNews, ingestFetchedPage } from "@/lib/news/collector";

type Update = { sql: string; values: unknown[] };

const checkedAt = "2026-08-05T12:00:00.000Z";
const source = {
  id: "source-1",
  organization_slug: "example",
  name: "Example news",
  url: "https://example.com/news",
  interval_minutes: 60,
  etag: null,
  last_modified: null,
  last_content_hash: null,
  failure_count: 0,
};

function createDb() {
  const updates: Update[] = [];
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...boundValues: unknown[]) {
          values = boundValues;
          return statement;
        },
        async run() {
          if (sql.includes("UPDATE news_sources SET")) {
            updates.push({ sql, values });
          }
          return {};
        },
        async first() {
          return sql.includes("FROM news_sources WHERE id") ? source : null;
        },
        async all() {
          return { results: sql.includes("FROM news_sources") ? [source] : [] };
        },
      };
      return statement;
    },
    async batch() {
      return [];
    },
  };
  return { db: db as unknown as D1Database, updates };
}

function healthUpdate(updates: Update[]) {
  const update = updates.find((item) => item.sql.includes("last_fetch_status"));
  assert.ok(update, "collector should persist source health");
  return update.values;
}

test("records validation failures as failed instead of healthy", async () => {
  const { db, updates } = createDb();

  await ingestFetchedPage(db, source.id, { status: 200, checkedAt });

  const values = healthUpdate(updates);
  assert.equal(values[4], "failed");
  assert.equal(values[5], "retry");
});

test("preserves a local ingest HTTP failure when an error is supplied", async () => {
  const { db, updates } = createDb();

  await ingestFetchedPage(db, source.id, {
    status: 429,
    error: "upstream collector rejected the response",
    checkedAt,
  });

  const values = healthUpdate(updates);
  assert.equal(values[4], "rate_limited");
  assert.equal(values[5], "backoff");
});

test("records an aborted collector fetch as a timeout", async () => {
  const { db, updates } = createDb();
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  try {
    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === "function") callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    globalThis.fetch = (async (_input, init) => {
      assert.equal(init?.signal?.aborted, true);
      throw new DOMException("request timed out", "AbortError");
    }) as typeof fetch;

    await collectLatestNews(db, { limit: 1 });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }

  const values = healthUpdate(updates);
  assert.equal(values[4], "timeout");
  assert.equal(values[5], "retry");
});

test("schedules retry classes at distinct intervals", async () => {
  const cases = [
    { status: 403, health: "blocked", retry: "manual", nextCheckAt: "9999-12-31T23:59:59.999Z", nextRetryAt: null },
    { status: 404, health: "missing", retry: "reprobe", nextCheckAt: "2026-08-12T12:00:00.000Z", nextRetryAt: "2026-08-12T12:00:00.000Z" },
    { status: 429, health: "rate_limited", retry: "backoff", nextCheckAt: "2026-08-05T14:00:00.000Z", nextRetryAt: "2026-08-05T14:00:00.000Z" },
    { status: 500, health: "failed", retry: "retry", nextCheckAt: "2026-08-05T13:00:00.000Z", nextRetryAt: "2026-08-05T13:00:00.000Z" },
  ];

  for (const item of cases) {
    const { db, updates } = createDb();
    await ingestFetchedPage(db, source.id, { status: item.status, checkedAt });
    const values = healthUpdate(updates);
    assert.equal(values[4], item.health);
    assert.equal(values[5], item.retry);
    assert.equal(values[1], item.nextCheckAt);
    assert.equal(values[6], item.nextRetryAt);
  }
});
