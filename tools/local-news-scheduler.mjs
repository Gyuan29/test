import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ProxyAgent, fetch } from "undici";
import { officialSiteKey } from "../lib/news/official-site-key.js";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lockPath = join(projectRoot, ".wrangler", "local-news-scheduler.lock");
const baseUrl = process.env.LOCAL_NEWS_APP_URL ?? "http://127.0.0.1:3000";
const intervalMs = 6 * 60 * 60 * 1000;
const recoveryPollMs = 15_000;
const sourceLimit = Math.min(Math.max(Number(process.env.LOCAL_NEWS_LIMIT ?? "30"), 1), 100);
const runOnce = process.env.LOCAL_NEWS_ONCE === "1";
const sourceFilter = process.env.LOCAL_NEWS_SOURCE ?? "";
const disableLock = process.env.LOCAL_NEWS_DISABLE_LOCK === "1";
const startupDelayMs = Math.max(Number(
  process.env.LOCAL_NEWS_START_DELAY_MS ?? (runOnce ? "0" : "45000"),
), 0);
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
let cycleRunning = false;

if (!disableLock) acquireLock();
process.on("exit", () => {
  if (!disableLock) releaseLock();
  else void dispatcher?.close();
});
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

if (startupDelayMs) {
  console.log(JSON.stringify({ event: "news-scheduler-startup-delay", delayMs: startupDelayMs }));
  await new Promise((resolve) => setTimeout(resolve, startupDelayMs));
}
await waitForApp();
await runCycle(true);
if (runOnce) process.exit(0);
setInterval(() => void runCycle(false), intervalMs);
setInterval(() => void processRecoveryRequest(), recoveryPollMs);
await new Promise(() => {});

async function runCycle(force) {
  if (cycleRunning) return;
  cycleRunning = true;
  const startedAt = new Date().toISOString();
  const recoveryRequest = force && typeof force === "object" ? force.recoveryRequest : null;
  try {
    const forceFetch = typeof force === "object" ? force.force : force;
    const recoveryScope = recoveryRequest?.scope ?? "";
    const sourceResponse = await fetch(
      `${baseUrl}/api/news/local-ingest?limit=${sourceLimit}${forceFetch ? "&force=1" : ""}${sourceFilter ? `&source=${encodeURIComponent(sourceFilter)}` : ""}${recoveryScope ? `&scope=${encodeURIComponent(recoveryScope)}` : ""}`,
      { signal: AbortSignal.timeout(20_000) },
    );
    if (!sourceResponse.ok) throw new Error(`source list HTTP ${sourceResponse.status}`);
    const { sources } = await sourceResponse.json();
    const results = [];
    for (let index = 0; index < sources.length; index += 4) {
      const batch = sources.slice(index, index + 4);
      results.push(...await Promise.all(batch.map((source) => fetchAndIngest(source, forceFetch))));
    }
    const failed = results.filter((result) => result.error).length;
    const errors = results
      .filter((result) => result.error)
      .map((result) => result.error)
      .slice(0, 8);
    const changed = results.filter((result) => result.changed).length;
    const candidatesFound = results.reduce(
      (total, result) => total + (Number(result.candidates) || 0),
      0,
    );
    const finishedAt = new Date().toISOString();
    await fetch(`${baseUrl}/api/news/local-ingest`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startedAt,
        finishedAt,
        checked: results.length,
        changed,
        candidatesFound,
        failed,
        errorSummary: errors.join("\n"),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    console.log(JSON.stringify({
      event: "collection-complete",
      startedAt,
      finishedAt,
      checked: results.length,
      changed,
      candidatesFound,
      failed,
      errors,
    }));
    if (recoveryRequest) await completeRecoveryRequest(recoveryRequest.id, recoveryRequest.lease_token);
  } catch (error) {
    if (recoveryRequest) await completeRecoveryRequest(recoveryRequest.id, recoveryRequest.lease_token, formatError(error));
    console.error(JSON.stringify({
      event: "collection-failed",
      startedAt,
      error: error instanceof Error ? error.message : String(error),
    }));
  } finally {
    cycleRunning = false;
  }
}

async function processRecoveryRequest() {
  if (cycleRunning) return;
  try {
    const recoveryRequest = await claimRecoveryRequest();
    if (recoveryRequest) await withRecoveryLease(recoveryRequest, () => runCycle({ force: true, recoveryRequest }));
  } catch (error) {
    console.error(JSON.stringify({
      event: "recovery-request-failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function claimRecoveryRequest() {
  const response = await fetch(`${baseUrl}/api/news/local-ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "claim-recovery" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`recovery request claim HTTP ${response.status}`);
  const { request } = await response.json();
  if (!request) return null;
  if (request.scope !== "retry_failed_sources" && request.scope !== "reprobe_missing_news_paths") {
    throw new Error("scheduler received an invalid recovery scope");
  }
  return request;
}

async function completeRecoveryRequest(requestId, leaseToken, error) {
  const response = await fetch(`${baseUrl}/api/news/local-ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "complete-recovery", requestId, leaseToken, ...(error ? { error } : {}) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`recovery request completion HTTP ${response.status}`);
  const result = await response.json();
  if (!result.completed) throw new Error("recovery lease is no longer held by this worker");
}

async function withRecoveryLease(request, operation) {
  const renew = () => void renewRecoveryLease(request).catch((error) => {
    console.error(JSON.stringify({ event: "recovery-lease-renew-failed", requestId: request.id, error: formatError(error) }));
  });
  const timer = setInterval(renew, 60_000);
  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
}

async function renewRecoveryLease(request) {
  const response = await fetch(`${baseUrl}/api/news/local-ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "renew-recovery", requestId: request.id, leaseToken: request.lease_token }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`recovery lease renewal HTTP ${response.status}`);
  const result = await response.json();
  if (!result.renewed) throw new Error("recovery lease is no longer held by this worker");
}

async function fetchAndIngest(source, force) {
  const checkedAt = new Date().toISOString();
  let payload;
  try {
    const fetched = await fetchOfficialSource(source, force);
    const response = fetched.response;
    if (response.status === 304) {
      payload = {
        sourceId: source.id,
        status: 304,
        etag: source.etag,
        lastModified: source.lastModified,
        checkedAt,
      };
    } else {
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!supportsSourceContent(source.sourceType, contentType)) {
        throw new Error(`unsupported content-type: ${contentType || "unknown"}`);
      }
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (declaredLength > 2_000_000) throw new Error("page exceeds 2 MB limit");
      payload = {
        sourceId: source.id,
        status: response.status,
        finalUrl: fetched.finalUrl,
        html: (await response.text()).slice(0, 2_000_000),
        contentType,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        checkedAt,
      };
    }
  } catch (error) {
    payload = {
      sourceId: source.id,
      status: 0,
      error: formatError(error),
      checkedAt,
    };
  }

  const ingestResponse = await fetch(`${baseUrl}/api/news/local-ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!ingestResponse.ok) throw new Error(`${source.name}: ingest HTTP ${ingestResponse.status}`);
  const result = await ingestResponse.json();
  const detailResults = [];
  const articleCandidates = (result.articleCandidates ?? []).slice(0, 12);
  for (let index = 0; index < articleCandidates.length; index += 3) {
    const batch = articleCandidates.slice(index, index + 3);
    detailResults.push(...await Promise.all(batch.map(fetchArticleDetails)));
  }
  return {
    ...result,
    articleDetails: detailResults.filter((item) => item.updated).length,
    articleDetailFailures: detailResults.filter((item) => item.error).length,
  };
}

async function fetchArticleDetails(article) {
  try {
    const response = await fetch(article.url, {
      dispatcher,
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new Error(`unsupported content-type: ${contentType || "unknown"}`);
    }
    const html = (await response.text()).slice(0, 2_000_000);
    const details = extractArticleDetails(html);
    const ingestResponse = await fetch(`${baseUrl}/api/news/local-ingest`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ articleId: article.id, ...details }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!ingestResponse.ok) throw new Error(`detail ingest HTTP ${ingestResponse.status}`);
    return { updated: true };
  } catch (error) {
    return { error: formatError(error) };
  }
}

function extractArticleDetails(html) {
  const title = metaContent(html, ["og:title", "twitter:title"])
    || cleanHtmlText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const summary = metaContent(html, ["og:description", "twitter:description", "description"])
    || cleanHtmlText(html.match(/["']description["']\s*:\s*["']([^"']{40,1200})["']/i)?.[1] ?? "")
    || firstSubstantiveParagraph(html);
  const publishedAt = metaContent(html, [
    "article:published_time",
    "datePublished",
    "publish-date",
    "date",
  ]) || html.match(/["']datePublished["']\s*:\s*["']([^"']+)["']/i)?.[1]
    || html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1]
    || undefined;
  return {
    title: title || undefined,
    summary: summary || undefined,
    publishedAt,
  };
}

function firstSubstantiveParagraph(html) {
  const content = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, " ");
  for (const match of content.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const value = cleanHtmlText(match[1]);
    if (value.length >= 80 && value.length <= 1200
      && !/(cookie|privacy policy|subscribe|newsletter)/i.test(value)) {
      return value;
    }
  }
  return "";
}

function metaContent(html, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const first = html.match(new RegExp(
      `<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`,
      "i",
    ));
    const second = html.match(new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`,
      "i",
    ));
    const value = cleanHtmlText(first?.[1] ?? second?.[1] ?? "");
    if (value) return value;
  }
  return "";
}

function cleanHtmlText(value) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchOfficialSource(source, force) {
  const officialSite = officialSiteKey(new URL(source.url).hostname);
  let nextUrl = new URL(source.url);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(nextUrl, {
      dispatcher,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: {
        accept: "text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/feed+json,application/json,application/xml,text/xml",
        ...(!force && source.etag ? { "if-none-match": source.etag } : {}),
        ...(!force && source.lastModified ? { "if-modified-since": source.lastModified } : {}),
      },
    });
    if (response.status < 300 || response.status >= 400) return { response, finalUrl: nextUrl.toString() };
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => {});
    if (!location || redirects === 5) throw new Error("unsafe or excessive redirect");
    const redirectUrl = new URL(location, nextUrl);
    if (redirectUrl.protocol !== "https:" || officialSiteKey(redirectUrl.hostname) !== officialSite) {
      throw new Error("redirect left verified official domain");
    }
    nextUrl = redirectUrl;
  }
  throw new Error("too many redirects");
}

function supportsSourceContent(sourceType, contentType) {
  if (!sourceType || sourceType === "html" || sourceType.startsWith("html-")) {
    return contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
  }
  if (sourceType === "rss" || sourceType === "atom" || sourceType === "sitemap") {
    return /(xml|rss|atom)/i.test(contentType);
  }
  return /(json|feed\+json)/i.test(contentType);
}

function formatError(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause && typeof cause === "object") {
    const code = typeof cause.code === "string" ? cause.code : "";
    const message = typeof cause.message === "string" ? cause.message : "";
    if (code || message) {
      return `${error.message}${code ? ` (${code})` : ""}${message ? `: ${message}` : ""}`;
    }
  }
  return error.message;
}

async function waitForApp() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/news?limit=1`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // The app is still compiling; retry below.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("local app did not become ready");
}

function acquireLock() {
  if (existsSync(lockPath)) {
    const existingPid = Number(readFileSync(lockPath, "utf8"));
    try {
      process.kill(existingPid, 0);
      console.log(JSON.stringify({ event: "scheduler-already-running", pid: existingPid }));
      process.exit(0);
    } catch {
      unlinkSync(lockPath);
    }
  }
  const descriptor = openSync(lockPath, "wx");
  writeFileSync(descriptor, String(process.pid));
  closeSync(descriptor);
}

function releaseLock() {
  try {
    if (existsSync(lockPath) && Number(readFileSync(lockPath, "utf8")) === process.pid) {
      unlinkSync(lockPath);
    }
  } catch {
    // Best-effort cleanup only.
  }
  void dispatcher?.close();
}
