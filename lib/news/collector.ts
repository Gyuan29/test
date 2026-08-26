import { classifySourceHealth } from "./source-health.js";
import { fetchExternalUrl } from "@/lib/security-url";

type FetchOptions = { fetchImpl?: typeof fetch; timeoutMs?: number; retries?: number };

export async function fetchOfficialSource(url: string, options: FetchOptions = {}): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retries = options.retries ?? 1;
  let last: Response | undefined;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = fetchImpl === fetch ? await fetchExternalUrl(url, { timeoutMs: options.timeoutMs }) : await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) });
    last = response;
    if (response.status < 500 && response.status !== 429) return response;
    try { await response.body?.cancel(); } catch {}
  }
  return last!;
}

function nextTimes(health: string, checkedAt: string) {
  const checked = new Date(checkedAt);
  if (health === "blocked") return { nextCheckAt: "9999-12-31T23:59:59.999Z", nextRetryAt: null };
  const minutes = health === "rate_limited" ? 120 : health === "missing" ? 7 * 24 * 60 : 60;
  const next = new Date(checked.getTime() + minutes * 60_000).toISOString();
  return { nextCheckAt: next, nextRetryAt: health === "missing" ? next : health === "failed" || health === "timeout" || health === "rate_limited" ? next : null };
}

export async function ingestFetchedPage(db: D1Database, sourceId: string, result: { status: number; error?: string; checkedAt?: string }) {
  const checkedAt = result.checkedAt ?? new Date().toISOString();
  const classified = classifySourceHealth(result.status === 0 ? { errorCode: "ETIMEDOUT" } : { status: result.status });
  const times = nextTimes(classified.health, checkedAt);
  await db.prepare("UPDATE news_sources SET last_checked_at = ?, next_check_at = ?, failure_count = failure_count + 1, last_modified = ?, etag = ?, last_fetch_status = ?, retry_class = ?, next_retry_at = ? WHERE id = ?")
    .bind(checkedAt, times.nextCheckAt, checkedAt, result.error ?? null, classified.health, classified.retryClass, times.nextRetryAt, sourceId)
    .run();
}

export async function collectLatestNews(db: D1Database, options: { limit?: number } = {}) {
  const sources = await db.prepare("SELECT * FROM news_sources ORDER BY next_check_at LIMIT ?").bind(options.limit ?? 30).all<Record<string, unknown>>();
  for (const source of sources.results) {
    const url = String(source.url ?? "");
    try {
      const response = await fetchOfficialSource(url);
      await ingestFetchedPage(db, String(source.id), { status: response.status, checkedAt: new Date().toISOString() });
    } catch (error) {
      await ingestFetchedPage(db, String(source.id), { status: 0, error: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() });
    }
  }
}
