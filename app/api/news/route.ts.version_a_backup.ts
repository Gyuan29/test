import { getDatabase, json } from "@/lib/db";

type NewsSource = {
  id: string;
  organization_slug: string;
  name: string;
  url: string;
  interval_minutes: number;
  etag: string | null;
  last_modified: string | null;
  last_content_hash: string | null;
  failure_count: number;
  last_fetch_status?: string | null;
  retry_class?: string | null;
  last_checked_at?: string | null;
  next_check_at?: string | null;
  next_retry_at?: string | null;
};

export async function GET(request: Request) {
  const db = await getDatabase();
  if (!db) {
    return json({ sources: [], sourceHealth: { retryable: 0, reprobe: 0 }, configured: false });
  }
  const organizationSlug = new URL(request.url).searchParams.get("organization");
  try {
    const result = await db
      .prepare(
        `SELECT id, organization_slug, name, url, interval_minutes, etag,
                last_modified, last_content_hash, failure_count,
                last_fetch_status, retry_class, last_checked_at,
                next_check_at, next_retry_at
         FROM news_sources
         ${organizationSlug ? "WHERE organization_slug = ?" : ""}
         ORDER BY name ASC LIMIT 500`,
      )
      .bind(...(organizationSlug ? [organizationSlug] : []))
      .all<NewsSource>();
    const sources = result.results;
    const retryable = sources.filter((source) => ["retry", "backoff"].includes(source.retry_class ?? "")).length;
    const reprobe = sources.filter((source) => source.retry_class === "reprobe").length;
    return json({ sources, sourceHealth: { retryable, reprobe }, configured: true });
  } catch {
    return json({ sources: [], sourceHealth: { retryable: 0, reprobe: 0 }, configured: true });
  }
}

/** Queue boundary for the collector; fetching is intentionally owned by lib/news/collector. */
export async function POST(request: Request) {
  let body: { organizationSlug?: string; limit?: number } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }
  return json(
    {
      status: "queued",
      organizationSlug: body.organizationSlug ?? null,
      limit: Math.min(Math.max(Number(body.limit) || 30, 1), 100),
      implementation: "collector_not_configured",
    },
    { status: 202 },
  );
}
