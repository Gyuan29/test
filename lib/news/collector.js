import { classifySourceHealth } from "./source-health.js";

async function fetchExternalUrl(url, options = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return new Response("blocked", { status: 400 }); }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|metadata(?:\.google\.internal)?$)/i.test(host) || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return new Response("blocked", { status: 400 });
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(parsed, { redirect: "manual", signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) });
  if (response.status >= 300 && response.status < 400) return new Response("blocked redirect", { status: 502 });
  return response;
}

export async function fetchOfficialSource(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retries = options.retries ?? 1;
  let last;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = fetchImpl === fetch ? await fetchExternalUrl(url, { timeoutMs: options.timeoutMs }) : await fetchExternalUrl(url, { fetchImpl, timeoutMs: options.timeoutMs });
    last = response;
    if (response.status < 500 && response.status !== 429) return response;
    try { await response.body?.cancel(); } catch {}
  }
  return last;
}

function nextTimes(health, checkedAt) {
  const checked = new Date(checkedAt);
  if (health === "blocked") return { nextCheckAt: "9999-12-31T23:59:59.999Z", nextRetryAt: null };
  const minutes = health === "rate_limited" ? 120 : health === "missing" ? 7 * 24 * 60 : 60;
  const next = new Date(checked.getTime() + minutes * 60_000).toISOString();
  return { nextCheckAt: next, nextRetryAt: health === "missing" || health === "failed" || health === "timeout" || health === "rate_limited" ? next : null };
}

export async function ingestFetchedPage(db, sourceId, result) {
  const checkedAt = result.checkedAt ?? new Date().toISOString();
  const classified = classifySourceHealth(result.status === 0 ? { errorCode: "ETIMEDOUT" } : { status: result.status });
  const times = nextTimes(classified.health, checkedAt);
  await db.prepare("UPDATE news_sources SET last_checked_at = ?, next_check_at = ?, failure_count = failure_count + 1, last_modified = ?, etag = ?, last_fetch_status = ?, retry_class = ?, next_retry_at = ? WHERE id = ?")
    .bind(checkedAt, times.nextCheckAt, checkedAt, result.error ?? null, classified.health, classified.retryClass, times.nextRetryAt, sourceId)
    .run();
}

export async function collectLatestNews(db, options = {}) {
  const sources = await db.prepare("SELECT * FROM news_sources ORDER BY next_check_at LIMIT ?").bind(options.limit ?? 30).all();
  for (const source of sources.results) {
    try {
      const response = await fetchOfficialSource(String(source.url ?? ""));
      await ingestFetchedPage(db, String(source.id), { status: response.status, checkedAt: new Date().toISOString() });
    } catch (error) {
      await ingestFetchedPage(db, String(source.id), { status: 0, error: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() });
    }
  }
}
