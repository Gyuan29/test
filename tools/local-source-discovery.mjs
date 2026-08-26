import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyAgent, fetch } from "undici";
import { discoverOfficialNewsEndpoints } from "../lib/news/news-endpoint-discovery.js";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lockPath = join(projectRoot, ".wrangler", "local-source-discovery.lock");
const baseUrl = process.env.LOCAL_NEWS_APP_URL ?? "http://127.0.0.1:3000";
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
const runOnce = process.env.LOCAL_SOURCE_DISCOVERY_ONCE === "1";
const force = process.env.LOCAL_SOURCE_DISCOVERY_FORCE === "1";
const concurrency = Math.min(Math.max(Number(process.env.LOCAL_SOURCE_DISCOVERY_CONCURRENCY ?? "5"), 1), 8);
const totalLimit = Math.max(Number(process.env.LOCAL_SOURCE_DISCOVERY_LIMIT_TOTAL ?? "0"), 0);
const startAfter = process.env.LOCAL_SOURCE_DISCOVERY_AFTER ?? "";
const entityStatus = process.env.LOCAL_SOURCE_DISCOVERY_STATUS ?? "";
const requestPollOnly = process.env.LOCAL_SOURCE_DISCOVERY_REQUEST_POLL === "1";
const startupDelayMs = Math.max(Number(
  process.env.LOCAL_SOURCE_DISCOVERY_START_DELAY_MS ?? (requestPollOnly ? "45000" : "0"),
), 0);
const intervalMs = 24 * 60 * 60 * 1000;
const SEARCH_DELAY_MS = Math.max(Number(process.env.LOCAL_SOURCE_DISCOVERY_SEARCH_DELAY_MS ?? "450"), 0);
const ENTITY_TOTAL_TIMEOUT_MS = Math.max(Number(process.env.LOCAL_SOURCE_DISCOVERY_ENTITY_TIMEOUT_MS ?? "30000"), 5_000);
const FETCH_TIMEOUT_MS = Math.max(Number(process.env.LOCAL_SOURCE_DISCOVERY_FETCH_TIMEOUT_MS ?? "12000"), 3_000);
const SEARCH_WAVE_TIMEOUT_MS = Math.max(Number(process.env.LOCAL_SOURCE_DISCOVERY_SEARCH_WAVE_TIMEOUT_MS ?? "14000"), 5_000);
const SEARCH_CACHE_TTL_MS = Math.max(Number(process.env.LOCAL_SOURCE_DISCOVERY_SEARCH_CACHE_TTL_MS ?? String(15 * 60 * 1000)), 0);
const SEARCH_NEGATIVE_CACHE_TTL_MS = Math.max(Number(process.env.LOCAL_SOURCE_DISCOVERY_SEARCH_NEGATIVE_CACHE_TTL_MS ?? String(2 * 60 * 1000)), 0);
const HTML_CACHE_TTL_MS = Math.max(Number(process.env.LOCAL_SOURCE_DISCOVERY_HTML_CACHE_TTL_MS ?? String(30 * 60 * 1000)), 0);
const HTML_NEGATIVE_CACHE_TTL_MS = Math.max(Number(process.env.LOCAL_SOURCE_DISCOVERY_HTML_NEGATIVE_CACHE_TTL_MS ?? String(2 * 60 * 1000)), 0);
const SEARX_INSTANCES = ["https://etsi.me/", "https://search.mdosch.de/searxng/"];
const SEARCH_COOLDOWN_MS = 30 * 60 * 1000;
const NON_APPLICABLE_TYPES = new Set(["地区", "技术方向"]);
const REJECT_HOSTS = /(wikipedia|baike\.|zhihu|linkedin|facebook|instagram|youtube|twitter|x\.com$|crunchbase|bloomberg|reuters|qcc\.com|tianyancha|企查查|sogou|baidu|bing|google|so\.com$|sohu\.com|toutiao\.com|sina\.com|163\.com|douyin\.com|jiemian\.com|mydrivers\.com|ebiotrade\.com|huangye88\.com|kiphub\.com|qq\.com|36kr\.com|csdn\.net|shenzhenware\.com)/i;
const PARKED_PAGE_HINT = /(domain (?:is )?for sale|buy this domain|parked (?:free|domain)|sedo domain parking|afternic|hugedomains|dan\.com\/buy-domain|该域名出售|域名正在出售)/i;
const NEWS_HINT = /(news|newsroom|blog|press|media|updates?|insights?|stories|journal|announcements?|新闻|新闻中心|动态|资讯|媒体|公告|要闻|聚焦|最新)/i;
const ARTICLE_HINT = /(news|blog|press|story|stories|update|insight|announce|award|funding|launch|partner|新闻|动态|资讯|发布|融资|合作|活动)/i;
const GENERIC_TOKENS = new Set([
  "the", "and", "for", "official", "website", "university", "college", "institute",
  "institution", "company", "corporation", "group", "project", "program", "programme",
  "technology", "technologies", "platform", "center", "centre", "accelerator", "incubator",
  "partnership", "foundation", "initiative", "organization", "organisation", "holdings",
  "business", "development", "innovation", "research", "science", "startup",
]);
const AMBIGUOUS_ENTITY_TOKENS = new Set([
  "academy", "accelerator", "centre", "center", "clean", "deep", "dice", "enterprise",
  "exist", "factory", "future", "gemini", "innovation", "ipco", "lab", "nexus", "orbit",
  "planet", "platform", "phta", "program", "project", "startup", "superconnector", "tech",
  "technology", "transfer", "unit", "venture", "ventures", "worlds",
]);

let searchGate = Promise.resolve();
let aiReviewGate = Promise.resolve();
let aiSearchGate = Promise.resolve();
let searchCounter = 0;
let searxCounter = 0;
const providerCooldowns = new Map();
const htmlCache = new Map();
const searchCache = new Map();
let wikipediaCandidates = new Map();
let requestedDiscoveryActive = false;
let activeAiReviewRequestId = "";
let activeAiSearchRequestId = "";
let activeRecoveryScope = "";
let activeEntityLimit = 0;
let activePrioritizeAfter = "";

acquireLock();
process.on("exit", releaseLock);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

if (startupDelayMs) {
  console.log(JSON.stringify({ event: "source-discovery-startup-delay", delayMs: startupDelayMs }));
  await new Promise((resolve) => setTimeout(resolve, startupDelayMs));
}
await waitForApp();
if (requestPollOnly) {
  await processRequestedDiscovery();
  setInterval(() => void processRequestedDiscovery(), 15_000);
} else {
  await runDiscovery(force);
  if (runOnce) process.exit(0);
  setInterval(() => void runDiscovery(false), intervalMs);
}
await new Promise(() => {});

async function processRequestedDiscovery() {
  if (requestedDiscoveryActive) return;
  requestedDiscoveryActive = true;
  try {
    const claim = await fetch(new URL("/api/news/discovery", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "claim-request" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!claim.ok) {
      await cancelResponseBody(claim);
      throw new Error(`discovery request claim HTTP ${claim.status}`);
    }
    const { request } = await claim.json();
    if (!request) return;
    const previousStatus = process.env.LOCAL_SOURCE_DISCOVERY_STATUS;
    const previousAiReviewRequestId = activeAiReviewRequestId;
    const previousAiSearchRequestId = activeAiSearchRequestId;
    const previousRecoveryScope = activeRecoveryScope;
    const previousEntityLimit = activeEntityLimit;
    const previousPrioritizeAfter = activePrioritizeAfter;
    try {
      process.env.LOCAL_SOURCE_DISCOVERY_STATUS = request.scope === "all"
        ? ""
        : request.scope === "candidate_search"
          ? "candidate"
          : request.scope === "ai_search"
            ? "not_found"
            : request.scope === "reprobe_missing_news_paths"
              ? ""
              : request.scope;
      activeRecoveryScope = request.scope === "reprobe_missing_news_paths" ? request.scope : "";
      activeAiReviewRequestId = request.scope === "candidate" ? request.id : "";
      activeAiSearchRequestId = request.scope === "ai_search" ? request.id : "";
      activeEntityLimit = activeAiSearchRequestId
        ? Math.min(Math.max(Number(request.entity_limit) || 50, 1), 50)
        : 0;
      activePrioritizeAfter = activeAiSearchRequestId && request.prioritize_after ? request.prioritize_after : "";
      if (activeAiReviewRequestId) await ensureAiReviewReady(activeAiReviewRequestId);
      if (activeAiSearchRequestId) await ensureAiSearchReady(activeAiSearchRequestId);
      await withDiscoveryLease(request, () => runDiscovery(request.scope !== "pending", activeEntityLimit, activePrioritizeAfter));
      await completeRequestedDiscovery(request.id, request.lease_token);
    } catch (error) {
      await completeRequestedDiscovery(request.id, request.lease_token, formatError(error));
    } finally {
      if (previousStatus === undefined) delete process.env.LOCAL_SOURCE_DISCOVERY_STATUS;
      else process.env.LOCAL_SOURCE_DISCOVERY_STATUS = previousStatus;
      activeAiReviewRequestId = previousAiReviewRequestId;
      activeAiSearchRequestId = previousAiSearchRequestId;
      activeRecoveryScope = previousRecoveryScope;
      activeEntityLimit = previousEntityLimit;
      activePrioritizeAfter = previousPrioritizeAfter;
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "source-discovery-request-poll-failed", error: formatError(error) }));
  } finally {
    requestedDiscoveryActive = false;
  }
}

async function completeRequestedDiscovery(requestId, leaseToken, error = "") {
  const response = await fetch(new URL("/api/news/discovery", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "complete-request", requestId, leaseToken, ...(error ? { error } : {}) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new Error(`discovery request completion HTTP ${response.status}`);
  }
  const result = await response.json();
  if (!result.completed) throw new Error("discovery lease is no longer held by this worker");
}

async function runDiscovery(forceRun, entityLimit = totalLimit, prioritizeAfter = "") {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const entities = await loadEntities(forceRun, entityLimit, prioritizeAfter);
  const stats = {
    runId,
    status: "running",
    startedAt,
    entitiesTotal: entities.length,
    entitiesProcessed: 0,
    officialVerified: 0,
    newsVerified: 0,
    candidatesFound: 0,
    notFound: 0,
    notApplicable: 0,
    failureCount: 0,
    errors: [],
  };
  await recordRun(stats);
  console.log(JSON.stringify({ event: "source-discovery-started", runId, total: entities.length }));

  try {
    wikipediaCandidates = await discoverWikipediaCandidates(entities);
    console.log(JSON.stringify({
      event: "source-discovery-structured-data",
      candidates: wikipediaCandidates.size,
      total: entities.length,
    }));
    const batchSize = activeAiReviewRequestId || activeAiSearchRequestId
      ? Math.min(concurrency, 2)
      : concurrency;
    for (let index = 0; index < entities.length; index += batchSize) {
      const batch = entities.slice(index, index + batchSize);
      const results = await Promise.all(batch.map(discoverEntity));
      const fatalAiError = results.find((result) => result.abortRun);
      if (fatalAiError) throw new Error(fatalAiError.error || "AI search plan generation failed");
      await postResults(results);
      for (const result of results) updateStats(stats, result);
      stats.entitiesProcessed += results.length;
      await recordRun(stats);
      console.log(JSON.stringify({
        event: "source-discovery-progress",
        processed: stats.entitiesProcessed,
        total: stats.entitiesTotal,
        officialVerified: stats.officialVerified,
        newsVerified: stats.newsVerified,
        candidates: stats.candidatesFound,
        notFound: stats.notFound,
        notApplicable: stats.notApplicable,
        failed: stats.failureCount,
      }));
    }
    stats.status = "completed";
    stats.finishedAt = new Date().toISOString();
    await recordRun(stats);
    console.log(JSON.stringify({ event: "source-discovery-complete", ...stats }));
  } catch (error) {
    stats.status = "failed";
    stats.finishedAt = new Date().toISOString();
    stats.errors.push(formatError(error));
    await recordRun(stats);
    console.error(JSON.stringify({ event: "source-discovery-failed", ...stats }));
    throw error;
  }
}

async function loadEntities(forceRun, entityLimit = totalLimit, prioritizeAfter = "") {
  const entities = [];
  let after = startAfter;
  while (true) {
    const url = new URL("/api/news/discovery", baseUrl);
    url.searchParams.set("mode", "entities");
    url.searchParams.set("limit", "50");
    if (after) url.searchParams.set("after", after);
    const activeStatus = process.env.LOCAL_SOURCE_DISCOVERY_STATUS ?? entityStatus;
    if (activeStatus) url.searchParams.set("entityStatus", activeStatus);
    if (prioritizeAfter) url.searchParams.set("prioritizeNotFoundAfter", prioritizeAfter);
    if (activeRecoveryScope) url.searchParams.set("recoveryScope", activeRecoveryScope);
    if (forceRun) url.searchParams.set("force", "1");
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error(`discovery entity list HTTP ${response.status}`);
    }
    const data = await response.json();
    const page = data.entities ?? [];
    if (!page.length) break;
    entities.push(...page);
    after = page.at(-1).organization_slug;
    if (page.length < 50 || (entityLimit && entities.length >= entityLimit)) break;
  }
  return entityLimit ? entities.slice(0, entityLimit) : entities;
}

async function discoverEntity(entity) {
  const checkedAt = new Date().toISOString();
  const base = {
    organizationSlug: entity.organization_slug,
    entityName: entity.entity_name,
    entityType: entity.entity_type,
    checkedAt,
    searchProvider: "direct-validation",
  };
  if (NON_APPLICABLE_TYPES.has(entity.entity_type)) {
    return {
      ...base,
      status: "not_applicable",
      confidence: 100,
      verificationReason: `${entity.entity_type}不适用单一机构官网；已完成分类判定`,
      candidates: [],
    };
  }

  return withTimeout(
    discoverEntityCore(entity, base),
    ENTITY_TOTAL_TIMEOUT_MS,
    () => ({
      ...base,
      status: "failed",
      confidence: 0,
      verificationReason: `单机构发现超过 ${ENTITY_TOTAL_TIMEOUT_MS}ms，已跳过并保留为失败项`,
      candidates: [],
      error: `entity discovery timeout after ${ENTITY_TOTAL_TIMEOUT_MS}ms`,
    }),
  );
}

async function discoverEntityCore(entity, base) {

  try {
    if (activeAiReviewRequestId && entity.status === "candidate") {
      return await reviewCandidateEntity(entity, base);
    }
    if (entity.source_url) {
      const verified = await verifyOfficialCandidate(entity, {
        url: entity.source_url,
        title: entity.entity_name,
        snippet: "existing registered source",
        officialBadge: true,
        preScore: 75,
        sourceKind: "registered",
      });
      if (verified) return buildVerifiedResult(base, entity, verified, `已登记来源复核通过；${verified.reason}`);
    }

    let query = buildQuery(entity);
    const structured = wikipediaCandidates.get(entity.organization_slug);
    if (structured) {
      const verified = await verifyOfficialCandidate(entity, structured);
      if (verified?.confidence >= 72) {
        return {
          ...buildVerifiedResult(base, entity, verified, `Wikipedia 信息框官网字段与站内身份复核通过；${verified.reason}`),
          query,
          searchProvider: "wikipedia-infobox+direct-validation",
          candidates: [{ url: verified.url, title: verified.title, score: verified.confidence }],
        };
      }
    }

    const guessed = buildDomainCandidates(entity);
    const parallelDomainVerified = (await Promise.all(
      guessed.map((candidate) => verifyOfficialCandidate(entity, candidate, Math.min(9_000, FETCH_TIMEOUT_MS))),
    ))
      .filter((verified) => verified?.confidence >= 72)
      .sort((a, b) => b.confidence - a.confidence)[0];
    if (parallelDomainVerified) {
      return {
        ...buildVerifiedResult(base, entity, parallelDomainVerified, `domain probe and identity validation passed: ${parallelDomainVerified.reason}`),
        query,
        searchProvider: "domain-probe+direct-validation",
        candidates: [{ url: parallelDomainVerified.url, title: parallelDomainVerified.title, score: parallelDomainVerified.confidence }],
      };
    }
    for (const candidate of guessed) {
      const verified = await verifyOfficialCandidate(entity, candidate, 9_000);
      if (verified?.confidence >= 72) {
        return {
          ...buildVerifiedResult(base, entity, verified, `官网域名探测与站内身份复核通过；${verified.reason}`),
          query,
          searchProvider: "domain-probe+direct-validation",
          candidates: [{ url: verified.url, title: verified.title, score: verified.confidence }],
        };
      }
    }

    let aiSearchPlan = null;
    if (activeAiSearchRequestId) {
      try {
        aiSearchPlan = await requestAiSearchPlan(entity);
      } catch (error) {
        return {
          ...base,
          status: "failed",
          confidence: 0,
          verificationReason: "AI 检索词生成失败，批次已停止；请检查模型配置后重试。",
          candidates: [],
          error: formatError(error),
          abortRun: true,
        };
      }
    }
    const searchQueries = [...new Set([query, ...(aiSearchPlan?.queries ?? [])])].slice(0, 3);
    let search = { provider: "search-exhausted", results: [], errors: [] };
    for (const searchQuery of searchQueries) {
      const attempt = await searchWeb(searchQuery, entity);
      search = {
        provider: attempt.provider,
        results: attempt.results,
        errors: [...search.errors, ...(attempt.errors ?? [])],
      };
      query = searchQuery;
      if (attempt.results.length) break;
    }
    base.searchProvider = `${activeAiSearchRequestId ? "gpt-4.1-mini+" : ""}${search.provider}+direct-validation`;
    const searchResults = search.results;
    const ranked = searchResults
      .map((candidate) => ({
        ...candidate,
        preScore: scoreSearchCandidate(entity, candidate),
      }))
      .filter((candidate) => candidate.preScore >= 20 && !isRejectedUrl(candidate.url))
      .sort((a, b) => b.preScore - a.preScore)
      .slice(0, 4);
    const verifiedCandidates = [];
    for (const candidate of ranked) {
      const verified = await verifyOfficialCandidate(entity, candidate);
      if (verified) verifiedCandidates.push(verified);
      if (verified?.confidence >= 82) break;
    }
    verifiedCandidates.sort((a, b) => b.confidence - a.confidence);
    const best = verifiedCandidates[0];
    const storedCandidates = [...verifiedCandidates, ...(structured ? [structured] : []), ...ranked]
      .slice(0, 5)
      .map((candidate) => ({
        url: candidate.url,
        title: candidate.title,
        score: candidate.confidence ?? candidate.preScore ?? 0,
      }));
    if (best?.confidence >= 72) {
      return {
        ...buildVerifiedResult(base, entity, best, best.reason),
        query,
        candidates: storedCandidates,
      };
    }
    if (best || ranked[0]) {
      const candidate = best ?? ranked[0];
      return {
        ...base,
        status: "candidate",
        query,
        officialUrl: candidate.url,
        officialTitle: candidate.title,
        confidence: candidate.confidence ?? candidate.preScore ?? 0,
        verificationReason: candidate.reason ?? "搜索结果相关，但未达到自动接入阈值",
        candidates: storedCandidates,
      };
    }
    return {
      ...base,
      status: "not_found",
      query,
      confidence: 0,
      verificationReason: search.errors?.length
        ? `结构化数据、域名探测和可用搜索源均未找到通过身份校验的官网；${search.errors.slice(-2).join("；")}`
        : "结构化数据、域名探测和搜索结果中没有通过实体名称与站点内容双重校验的官网",
      candidates: searchResults.slice(0, 5).map((candidate) => ({
        url: candidate.url,
        title: candidate.title,
        score: 0,
      })),
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      confidence: 0,
      verificationReason: "来源发现请求失败，等待自动重试",
      candidates: [],
      error: formatError(error),
    };
  }
}

async function reviewCandidateEntity(entity, base) {
  const candidates = storedCandidateList(entity);
  const reviewNotes = [];
  for (const candidate of candidates.slice(0, 3)) {
    const verified = await verifyOfficialCandidate(entity, {
      url: candidate.url,
      title: candidate.title || entity.entity_name,
      snippet: "stored candidate for AI review",
      officialBadge: false,
      preScore: Math.min(Math.max(Number(candidate.score) || 20, 20), 70),
      sourceKind: "ai-review",
    });
    if (!verified?.evidence) {
      reviewNotes.push(`${candidate.url}: deterministic identity check failed`);
      continue;
    }
    let aiReview;
    try {
      aiReview = await requestAiCandidateReview(entity, verified);
    } catch (error) {
      reviewNotes.push(`${candidate.url}: ${formatError(error)}`);
      continue;
    }
    const approved = aiReview.verdict === "official"
      && aiReview.confidence >= 85
      && verified.confidence >= 50
      && !(aiReview.conflicts?.length);
    if (approved) {
      const confidence = Math.min(
        100,
        Math.max(72, Math.round((verified.confidence + aiReview.confidence) / 2)),
      );
      return {
        ...buildVerifiedResult(
          base,
          entity,
          { ...verified, confidence },
          `AI候选复核通过（${aiReview.confidence}分）；${aiReview.reason}；${verified.reason}`,
        ),
        searchProvider: "stored-candidate+direct-validation+ai-review",
        candidates,
      };
    }
    reviewNotes.push(`${candidate.url}: AI ${aiReview.verdict} ${aiReview.confidence}; ${aiReview.reason}`);
  }
  const primary = candidates[0];
  return {
    ...base,
    status: "candidate",
    query: entity.query || buildQuery(entity),
    officialUrl: primary?.url || entity.official_url,
    officialTitle: primary?.title || entity.official_title,
    confidence: Math.min(Math.max(Number(primary?.score ?? entity.confidence) || 0, 0), 100),
    verificationReason: reviewNotes.length
      ? `AI候选复核未达到自动接入标准；${reviewNotes.slice(0, 3).join("；")}`
      : "候选站点未通过确定性身份校验，未提交给AI确认",
    candidates,
    searchProvider: "stored-candidate+direct-validation+ai-review",
  };
}

function storedCandidateList(entity) {
  let stored = [];
  try {
    const parsed = JSON.parse(entity.candidates_json || "[]");
    if (Array.isArray(parsed)) stored = parsed;
  } catch {
    stored = [];
  }
  if (entity.official_url) {
    stored.unshift({
      url: entity.official_url,
      title: entity.official_title || entity.entity_name,
      score: entity.confidence || 0,
    });
  }
  const seen = new Set();
  return stored.filter((candidate) => {
    const url = normalizeCandidateUrl(candidate?.url);
    if (!url || isRejectedUrl(url) || seen.has(url)) return false;
    candidate.url = url;
    candidate.title = String(candidate.title || "").slice(0, 500);
    candidate.score = Math.min(Math.max(Number(candidate.score) || 0, 0), 100);
    seen.add(url);
    return true;
  }).slice(0, 5);
}

async function ensureAiReviewReady(requestId) {
  const response = await fetch(new URL("/api/news/discovery/ai-verify", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "check", requestId }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `AI review preflight HTTP ${response.status}`);
  }
  await consumeResponseBody(response);
}

async function requestAiCandidateReview(entity, verified) {
  await throttleAiReview();
  const response = await fetch(new URL("/api/news/discovery/ai-verify", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "review",
      requestId: activeAiReviewRequestId,
      item: {
        organizationSlug: entity.organization_slug,
        entityName: entity.entity_name,
        entityType: entity.entity_type,
        region: entity.region,
        city: entity.city,
        summary: entity.summary,
        candidateUrl: verified.url,
        pageTitle: verified.evidence.pageTitle,
        pageDescription: verified.evidence.pageDescription,
        pageExcerpt: verified.evidence.pageExcerpt,
        deterministicConfidence: verified.confidence,
        deterministicReason: verified.reason,
      },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.review) {
    throw new Error(data.error || `AI candidate review HTTP ${response.status}`);
  }
  return data.review;
}

async function ensureAiSearchReady(requestId) {
  const response = await fetch(new URL("/api/news/discovery/ai-search", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "check", requestId }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.configured) {
    throw new Error(data.error || `AI search preflight HTTP ${response.status}`);
  }
}

async function requestAiSearchPlan(entity) {
  await throttleAiSearch();
  const response = await fetch(new URL("/api/news/discovery/ai-search", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "plan",
      requestId: activeAiSearchRequestId,
      item: {
        organizationSlug: entity.organization_slug,
        entityName: entity.entity_name,
        entityType: entity.entity_type,
        region: entity.region,
        city: entity.city,
        summary: entity.summary,
      },
    }),
    signal: AbortSignal.timeout(25_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(data.plan?.queries)) {
    throw new Error(data.error || `AI search plan HTTP ${response.status}`);
  }
  return data.plan;
}

function buildVerifiedResult(base, entity, verified, reason) {
  const news = verified.news;
  return {
    ...base,
    status: news ? "news_verified" : "official_verified",
    query: buildQuery(entity),
    officialUrl: verified.url,
    officialTitle: verified.title,
    newsUrl: news?.url,
    newsTitle: news?.title,
    newsSourceType: news?.sourceType,
    confidence: verified.confidence,
    verificationReason: news
      ? `${reason}；新闻栏目已验证（${news.articleLinks}个文章信号，${news.sourceType}）`
      : `${reason}；官网已验证，但未定位到稳定新闻栏目`,
    candidates: [{ url: verified.url, title: verified.title, score: verified.confidence }],
  };
}

async function searchSogou(query) {
  await throttleSearch();
  const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    dispatcher,
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: browserHeaders(query),
  });
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new Error(`Sogou HTTP ${response.status}`);
  }
  const html = (await response.text()).slice(0, 1_500_000);
  if (/antispider|请输入验证码|访问过于频繁/i.test(html)) {
    throw new Error("Sogou verification challenge");
  }
  return parseSogouResults(html);
}

async function searchDuckDuckGo(query) {
  await throttleSearch();
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    dispatcher,
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: browserHeaders(query),
  });
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new Error(`DuckDuckGo HTTP ${response.status}`);
  }
  const html = (await response.text()).slice(0, 1_500_000);
  return parseDuckDuckGoResults(html);
}

async function searchWeb(query, entity) {
  const cached = searchCache.get(query);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const pending = searchWebCore(query, entity).then((result) => {
    const ttl = result.results.length ? SEARCH_CACHE_TTL_MS : SEARCH_NEGATIVE_CACHE_TTL_MS;
    if (ttl > 0) searchCache.set(query, { value: Promise.resolve(result), expiresAt: Date.now() + ttl });
    else searchCache.delete(query);
    return result;
  }).catch((error) => {
    searchCache.delete(query);
    throw error;
  });
  searchCache.set(query, { value: pending, expiresAt: Date.now() + Math.max(SEARCH_WAVE_TIMEOUT_MS, SEARCH_NEGATIVE_CACHE_TTL_MS) });
  return pending;
}

async function searchWebCore(query, entity) {
  const hasLatinName = /[A-Za-z]{2,}/.test(entity.entity_name);
  const chineseOrder = searchCounter++ % 2 === 0
    ? [["360-html", search360], ["sogou-html", searchSogou]]
    : [["sogou-html", searchSogou], ["360-html", search360]];
  const firstSearx = SEARX_INSTANCES[searxCounter++ % SEARX_INSTANCES.length];
  const secondSearx = SEARX_INSTANCES.find((url) => url !== firstSearx);
  const searxOrder = [
    [`searx-json:${new URL(firstSearx).hostname}`, (value) => searchSearx(value, firstSearx)],
    [`searx-json:${new URL(secondSearx).hostname}`, (value) => searchSearx(value, secondSearx)],
  ];
  const order = hasLatinName
    ? [["duckduckgo-html", searchDuckDuckGo], ...searxOrder, ...chineseOrder]
    : [...chineseOrder, ["duckduckgo-html", searchDuckDuckGo], ...searxOrder];
  const errors = [];
  const waves = hasLatinName
    ? [order.slice(0, 2), order.slice(2, 4), order.slice(4)]
    : [order.slice(0, 2), order.slice(2, 4), order.slice(4)];
  for (const wave of waves) {
    const available = wave.filter(([provider]) => (providerCooldowns.get(provider) ?? 0) <= Date.now());
    for (const [provider] of wave) {
      if (!available.some(([candidate]) => candidate === provider)) errors.push(`${provider}: cooling down`);
    }
    if (!available.length) continue;
    const attempts = available.map(([provider, search]) => (async () => {
      try {
        const results = await search(query);
        if (!results.length) throw new Error("no results");
        return { provider, results };
      } catch (error) {
        const message = formatError(error);
        errors.push(`${provider}: ${message}`);
        if (/\b(?:403|429)\b|challenge|too many|rate limit/i.test(message)) {
          providerCooldowns.set(provider, Date.now() + SEARCH_COOLDOWN_MS);
        }
        throw error;
      }
    })());
    const waveTimeout = Symbol("search-wave-timeout");
    const firstResult = await Promise.race([
      Promise.any(attempts).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(waveTimeout), SEARCH_WAVE_TIMEOUT_MS)),
    ]);
    if (firstResult && firstResult !== waveTimeout) return firstResult;
    if (firstResult === waveTimeout) {
      errors.push(`${available.map(([provider]) => provider).join(",")}: wave timeout`);
    }
  }
  return { provider: "search-exhausted", results: [], errors };
}

async function discoverWikipediaCandidates(entities) {
  const matches = new Map();
  const groups = new Map([["zh", []], ["en", []]]);
  for (const entity of entities) {
    if (NON_APPLICABLE_TYPES.has(entity.entity_type)) continue;
    const title = canonicalEntityName(entity.entity_name);
    if (!title || title.length > 100) continue;
    const language = hasHan(title) ? "zh" : "en";
    groups.get(language).push({ entity, title });
  }
  for (const [language, entries] of groups) {
    const batches = [];
    for (let index = 0; index < entries.length; index += 50) batches.push(entries.slice(index, index + 50));
    for (let index = 0; index < batches.length; index += 2) {
      const pages = await Promise.all(batches.slice(index, index + 2).map((batch) =>
        fetchWikipediaBatch(language, batch).catch((error) => {
          console.error(JSON.stringify({ event: "wikipedia-batch-failed", language, error: formatError(error) }));
          return [];
        }),
      ));
      for (const result of pages.flat()) matches.set(result.slug, result.candidate);
    }
  }
  return matches;
}

async function fetchWikipediaBatch(language, entries) {
  const endpoint = `https://${language}.wikipedia.org/w/api.php`;
  const body = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "revisions",
    rvprop: "content",
    rvslots: "main",
    redirects: "1",
    titles: entries.map((entry) => entry.title).join("|"),
  });
  const response = await fetch(endpoint, {
    method: "POST",
    dispatcher,
    signal: AbortSignal.timeout(75_000),
    headers: {
      "user-agent": "InstitutionSourceDiscovery/1.0",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body,
  });
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new Error(`Wikipedia ${language} HTTP ${response.status}`);
  }
  const data = await response.json();
  const redirects = new Map((data.query?.redirects ?? []).map((item) => [normalizeTitle(item.from), normalizeTitle(item.to)]));
  const byTitle = new Map();
  for (const page of data.query?.pages ?? []) {
    if (page.missing) continue;
    const wikiText = page.revisions?.[0]?.slots?.main?.content ?? "";
    const officialUrl = extractInfoboxWebsite(wikiText);
    if (!officialUrl || isRejectedUrl(officialUrl)) continue;
    byTitle.set(normalizeTitle(page.title), { officialUrl, pageTitle: page.title, wikiText });
  }
  const results = [];
  for (const entry of entries) {
    const normalized = normalizeTitle(entry.title);
    const page = byTitle.get(redirects.get(normalized) ?? normalized);
    if (!page) continue;
    const identity = entityIdentity(entry.entity.entity_name);
    const wikiHaystack = normalizeText(`${page.pageTitle} ${page.wikiText.slice(0, 80_000)}`);
    const contextMatches = contextTokens(entry.entity).filter((token) => containsNormalizedToken(wikiHaystack, token)).length;
    const requiresContext = entry.entity.entity_type === "人物"
      || (!hasHan(entry.entity.entity_name) && identity.tokens.length <= 1 && normalizeText(entry.entity.entity_name).length <= 8);
    if (requiresContext && contextMatches === 0) continue;
    results.push({
      slug: entry.entity.organization_slug,
      candidate: {
        url: page.officialUrl,
        title: page.pageTitle,
        snippet: page.wikiText.slice(0, 40_000),
        officialBadge: true,
        preScore: Math.min(70, 55 + contextMatches * 5),
        structuredSource: "wikipedia-infobox",
        sourceKind: "structured",
      },
    });
  }
  return results;
}

function extractInfoboxWebsite(wikiText) {
  const field = wikiText.match(/^\|\s*(?:website|homepage|official_website|url|官网|官方网站|网站|網址)\s*=\s*(.+)$/imu)?.[1] ?? "";
  const raw = field.match(/https?:\/\/[^\s}\]|<>]+/i)?.[0]
    ?? field.match(/(?:^|[|{\s])(www\.[a-z0-9.-]+(?:\/[^\s}\]|<>]*)?)/i)?.[1]
    ?? "";
  if (!raw) return "";
  return normalizeCandidateUrl(raw.startsWith("www.") ? `https://${raw}` : raw.replace(/[),.;]+$/, ""));
}

function buildDomainCandidates(entity) {
  if (entity.entity_type === "人物") return [];
  const name = canonicalEntityName(entity.entity_name);
  if (!/[A-Za-z]{3}/.test(name)) return [];
  const tokens = normalizeText(name).split(" ").filter((token) =>
    /^[a-z0-9]+$/.test(token) && token.length >= 2 && !GENERIC_TOKENS.has(token),
  ).slice(0, 4);
  const compact = tokens.join("");
  if (compact.length < 4 || compact.length > 32) return [];
  const variants = [...new Set([compact, tokens.join("-")])].slice(0, 2);
  return variants.flatMap((domain) => ["com", "org"].map((tld) => ({
    url: `https://${domain}.${tld}/`,
    title: name,
    snippet: "direct domain probe",
    officialBadge: false,
    preScore: 42,
    sourceKind: "domain-probe",
  }))).slice(0, 3);
}

async function searchSearx(query, instance) {
  await throttleSearch();
  const url = new URL("search", instance);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const response = await fetch(url, {
    dispatcher,
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": "institution-source-discovery/1.0" },
  });
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new Error(`SearXNG HTTP ${response.status}`);
  }
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error("SearXNG response too large");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("SearXNG returned invalid JSON");
  }
  return (data.results ?? []).slice(0, 8).flatMap((item) => {
    const url = normalizeCandidateUrl(item.url ?? "");
    const title = cleanText(item.title ?? "");
    if (!url || !title) return [];
    return [{
      url,
      title,
      snippet: cleanText(item.content ?? ""),
      officialBadge: false,
    }];
  });
}

async function search360(query) {
  await throttleSearch();
  const url = `https://so.com/s?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    dispatcher,
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: browserHeaders(query),
  });
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new Error(`360 Search HTTP ${response.status}`);
  }
  const html = (await response.text()).slice(0, 1_500_000);
  if (/请输入验证码|访问过于频繁|人机验证|异常访问/i.test(html)) {
    throw new Error("360 Search verification challenge");
  }
  return parse360Results(html);
}

function parseSogouResults(html) {
  const segments = html.split(/<div class="vrwrap"/i).slice(1, 9);
  const results = [];
  for (const segment of segments) {
    const titleHtml = segment.match(/<h3[^>]*>[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "";
    const title = cleanText(titleHtml);
    const snippet = cleanText(
      segment.match(/<div[^>]+(?:cacheresult_summary|space-txt)[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "",
    );
    const linkUrl = decodeHtml(segment.match(/\blinkurl=(?:"|')?(https?:[^\s>"']+)/i)?.[1] ?? "");
    const citeUrl = decodeHtml(
      segment.match(/class="citeLinkClass"[\s\S]{0,1800}?<span[^>]*>\s*(https?:\/\/[^<\s]+)/i)?.[1]
        ?? segment.match(/<span[^>]*>\s*(https?:\/\/[^<\s]+)<\/span>/i)?.[1]
        ?? "",
    );
    const url = normalizeCandidateUrl(linkUrl || citeUrl);
    if (!title || !url || results.some((item) => item.url === url)) continue;
    results.push({
      url,
      title,
      snippet,
      officialBadge: /官方网站认证|官网认证/i.test(segment.slice(0, 5000)),
    });
  }
  return results;
}

function parse360Results(html) {
  const segments = html.split(/<li class="res-list"/i).slice(1, 9);
  const results = [];
  for (const segment of segments) {
    const titleHtml = segment.match(/<h3[^>]*>[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "";
    const title = cleanText(titleHtml);
    const snippet = cleanText(
      segment.match(/<p class="res-desc"[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "",
    );
    const directUrl = decodeHtml(
      segment.match(/\bdata-mdurl="([^"]+)"/i)?.[1]
        ?? segment.match(/\bdata-mdurl='([^']+)'/i)?.[1]
        ?? "",
    );
    const url = normalizeCandidateUrl(directUrl);
    if (!title || !url || results.some((item) => item.url === url)) continue;
    results.push({
      url,
      title,
      snippet,
      officialBadge: /官网|官方网站/i.test(segment.slice(0, 5000)),
    });
  }
  return results;
}

function parseDuckDuckGoResults(html) {
  const results = [];
  for (const match of html.matchAll(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = cleanText(match[2]);
    const url = normalizeDuckDuckGoUrl(match[1]);
    if (!title || !url || results.some((item) => item.url === url)) continue;
    results.push({ url, title, snippet: "", officialBadge: false });
    if (results.length >= 8) break;
  }
  return results;
}

function normalizeDuckDuckGoUrl(value) {
  const decoded = decodeHtml(value);
  try {
    const url = new URL(decoded, "https://html.duckduckgo.com/");
    if (url.hostname.endsWith("duckduckgo.com")) {
      const target = url.searchParams.get("uddg");
      return target ? normalizeCandidateUrl(target) : "";
    }
    return normalizeCandidateUrl(url.toString());
  } catch {
    return "";
  }
}

async function verifyOfficialCandidate(entity, candidate, timeout = FETCH_TIMEOUT_MS) {
  const page = await fetchHtml(candidate.url, timeout);
  if (!page || isRejectedUrl(page.url)) return null;
  const searchable = cleanText(`${page.title} ${page.description} ${page.html.slice(0, 250_000)}`);
  if (PARKED_PAGE_HINT.test(searchable)) return null;
  const identity = scoreIdentityMatch(entity, searchable, page.url);
  const identityScore = identity.score;
  const confidence = Math.min(100, candidate.preScore + identityScore);
  const trustedRegisteredSource = candidate.officialBadge
    && candidate.snippet === "existing registered source";
  const sourceKind = candidate.sourceKind ?? "search";
  const domainProbe = sourceKind === "domain-probe";
  const minimumContextMatches = sourceKind === "registered" || sourceKind === "structured"
    ? 0
    : requiredCandidateContextMatches(entity, identity);
  if (
    identityScore < 20
    || confidence < 45
    || (!trustedRegisteredSource && identity.requiresContext && identity.contextMatches === 0)
    || (!trustedRegisteredSource && identity.requiresHostMatch && identity.hostMatches === 0)
    || (domainProbe && identity.hostMatches === 0)
    || (identity.contextMatches < minimumContextMatches)
  ) return null;
  const pathHints = Array.isArray(entity.path_hints_json)
    ? entity.path_hints_json
    : (() => {
      try { return JSON.parse(entity.path_hints_json || "[]"); } catch { return []; }
    })();
  const news = confidence >= 65 ? await locateNewsPage(page, pathHints, entity.route_kind) : null;
  return {
    url: page.url,
    title: page.title || candidate.title,
    confidence,
    reason: `搜索相关度${candidate.preScore}，站内实体校验${identityScore}，报告上下文命中${identity.contextMatches}，域名命中${identity.hostMatches}`,
    news,
    evidence: {
      pageTitle: page.title || candidate.title || "",
      pageDescription: page.description || "",
      pageExcerpt: searchable.slice(0, 14_000),
    },
  };
}

function requiredCandidateContextMatches(entity, identity) {
  const canonical = canonicalEntityName(entity.entity_name);
  const normalized = normalizeText(canonical);
  const nameWasExpanded = normalizeText(entity.entity_name) !== normalized;
  const genericName = identity.tokens.some((token) => AMBIGUOUS_ENTITY_TOKENS.has(token));
  const shortIdentity = identity.domainTokens.length <= 1
    && (identity.domainTokens[0]?.length ?? normalized.length) < 10;
  const genericType = /孵化|转化平台|政策|项目|政府|公共机构/.test(entity.entity_type);
  const acronym = /^[A-Z0-9][A-Z0-9.&+-]{1,5}$/.test(canonical);
  if (acronym) return 2;
  return nameWasExpanded || genericName || shortIdentity || genericType ? 1 : 0;
}

async function locateNewsPage(homePage, pathHints = [], routeKind = "generic") {
  const commonPaths = hasHan(homePage.html)
    ? ["xwzx", "news", "xinwen"]
    : ["news", "blog", "newsroom"];
  const endpoints = await discoverOfficialNewsEndpoints({
    homepageUrl: homePage.url,
    html: homePage.html,
    pathHints: [...pathHints, ...commonPaths],
    preferredSourceTypes: preferredSourceTypesForRoute(routeKind),
  });
  for (const endpoint of endpoints.slice(0, 10)) {
    if (endpoint.sourceType === "html") {
      const document = endpoint.url === homePage.url
        ? { url: homePage.url, text: homePage.html }
        : await fetchNewsEndpoint(endpoint.url, homePage.url, 12_000);
      if (!document) continue;
      const articleLinks = countArticleLinks(document.text, document.url);
      const title = cleanText(document.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? endpoint.title);
      const pageSignal = NEWS_HINT.test(`${document.url} ${title}`) ? 1 : 0;
      if (articleLinks >= 2 || (pageSignal && articleLinks >= 1)) {
        return { url: document.url, title, articleLinks, sourceType: "html", evidence: endpoint.evidence };
      }
      continue;
    }
    const document = await fetchNewsEndpoint(endpoint.url, homePage.url, 12_000);
    if (!document) continue;
    const articleLinks = await countEndpointArticles(endpoint.sourceType, document.text, document.url, homePage.url);
    if (articleLinks > 0) {
      return {
        url: document.url,
        title: endpoint.title,
        articleLinks,
        sourceType: endpoint.sourceType,
        evidence: endpoint.evidence,
      };
    }
  }
  const homeArticles = countArticleLinks(homePage.html, homePage.url);
  if (homeArticles >= 2) {
    return {
      url: homePage.url,
      title: homePage.title,
      articleLinks: homeArticles,
      sourceType: "html",
      evidence: "homepage-article-index",
    };
  }
  return null;
}

async function withDiscoveryLease(request, operation) {
  const renew = () => void renewDiscoveryLease(request).catch((error) => {
    console.error(JSON.stringify({ event: "discovery-lease-renew-failed", requestId: request.id, error: formatError(error) }));
  });
  const timer = setInterval(renew, 60_000);
  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
}

async function renewDiscoveryLease(request) {
  const response = await fetch(new URL("/api/news/discovery", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "renew-request", requestId: request.id, leaseToken: request.lease_token }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`discovery lease renewal HTTP ${response.status}`);
  const result = await response.json();
  if (!result.renewed) throw new Error("discovery lease is no longer held by this worker");
}

function preferredSourceTypesForRoute(routeKind) {
  return ["enterprise", "research", "public"].includes(routeKind)
    ? ["rss", "api", "html", "sitemap"]
    : ["rss", "html", "sitemap", "api"];
}

async function fetchNewsEndpoint(value, homepageUrl, timeout = FETCH_TIMEOUT_MS) {
  let endpoint;
  try {
    endpoint = new URL(value);
    assertSafePublicUrl(endpoint);
    if (siteKey(endpoint.hostname) !== siteKey(new URL(homepageUrl).hostname)) return null;
  } catch {
    return null;
  }
  try {
    const homepageSite = siteKey(new URL(homepageUrl).hostname);
    let nextUrl = endpoint;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const response = await fetch(nextUrl, {
        dispatcher,
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(timeout, FETCH_TIMEOUT_MS)),
        headers: { ...browserHeaders(), accept: "text/html, application/xhtml+xml, application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml, text/xml" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await cancelResponseBody(response);
        if (!location || redirects === 5) return null;
        const redirectUrl = new URL(location, nextUrl);
        assertSafePublicUrl(redirectUrl);
        if (siteKey(redirectUrl.hostname) !== homepageSite) return null;
        nextUrl = redirectUrl;
        continue;
      }
      if (!response.ok) {
        await cancelResponseBody(response);
        return null;
      }
      const finalUrl = new URL(response.url || nextUrl);
      assertSafePublicUrl(finalUrl);
      if (siteKey(finalUrl.hostname) !== homepageSite) {
        await cancelResponseBody(response);
        return null;
      }
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (declaredLength > 2_000_000) {
        await cancelResponseBody(response);
        return null;
      }
      const text = await readLimitedResponseText(response, 2_000_000);
      if (text === null) return null;
      return { url: finalUrl.toString(), text };
    }
    return null;
  } catch {
    return null;
  }
}

async function readLimitedResponseText(response, limit) {
  if (!response.body) {
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength <= limit ? text : null;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function countEndpointArticles(sourceType, text, endpointUrl, homepageUrl) {
  if (sourceType === "rss" || sourceType === "atom") {
    return Math.min((text.match(/<(?:item|entry)\b/gi) ?? []).length, 20);
  }
  if (sourceType === "json" || sourceType === "api") {
    try {
      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed) ? parsed : parsed.items;
      return Array.isArray(items) ? Math.min(items.filter((item) => item && typeof item === "object").length, 20) : 0;
    } catch {
      return 0;
    }
  }
  if (sourceType === "sitemap") {
    return countSitemapNewsUrls(text, endpointUrl, homepageUrl);
  }
  return 0;
}

async function countSitemapNewsUrls(text, endpointUrl, homepageUrl, depth = 0) {
  const officialSite = siteKey(new URL(homepageUrl).hostname);
  const isSitemapIndex = /<sitemapindex\b/i.test(text);
  const newsUrls = new Set();
  const childSitemaps = [];
  for (const match of text.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
    try {
      const url = new URL(decodeHtml(match[1].trim()), endpointUrl);
      if (url.protocol !== "https:" || siteKey(url.hostname) !== officialSite) continue;
      if (isSitemapIndex) {
        if (/sitemap[^/]*\.xml$/i.test(url.pathname)) childSitemaps.push(url.toString());
      } else if (NEWS_HINT.test(url.pathname)) {
        newsUrls.add(url.toString());
      }
    } catch {
      continue;
    }
    if (newsUrls.size >= 20) break;
  }
  if (newsUrls.size || depth >= 1) return newsUrls.size;
  for (const childUrl of [...new Set(childSitemaps)].slice(0, 3)) {
    const child = await fetchNewsEndpoint(childUrl, homepageUrl, 12_000);
    if (!child) continue;
    const count = await countSitemapNewsUrls(child.text, child.url, homepageUrl, depth + 1);
    if (count) return count;
  }
  return 0;
}

function countArticleLinks(html, baseUrl) {
  const urls = new Set();
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = cleanText(match[3]);
    if (text.length < 7 || text.length > 260) continue;
    let url;
    try {
      url = new URL(decodeHtml(match[2]), baseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || siteKey(url.hostname) !== siteKey(new URL(baseUrl).hostname)) continue;
    const depth = url.pathname.split("/").filter(Boolean).length;
    if (depth < 2 || !ARTICLE_HINT.test(`${url.pathname} ${text}`)) continue;
    if (/^\/(?:news|newsroom|blog|press|media|xwzx|xinwen)\/?$/i.test(url.pathname)) continue;
    urls.add(url.toString().split("#")[0]);
    if (urls.size >= 20) break;
  }
  return urls.size;
}

async function fetchHtml(value, timeout = FETCH_TIMEOUT_MS) {
  let key;
  try {
    const normalized = normalizeCandidateUrl(value);
    if (!normalized) return null;
    const url = new URL(normalized);
    assertSafePublicUrl(url);
    key = url.toString();
  } catch {
    return null;
  }
  const now = Date.now();
  const cached = htmlCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  const pending = fetchHtmlUncached(key, timeout).then((result) => {
    const ttl = result ? HTML_CACHE_TTL_MS : HTML_NEGATIVE_CACHE_TTL_MS;
    if (ttl > 0) htmlCache.set(key, { value: Promise.resolve(result), expiresAt: Date.now() + ttl });
    else htmlCache.delete(key);
    return result;
  }).catch(() => {
    htmlCache.delete(key);
    return null;
  });
  htmlCache.set(key, { value: pending, expiresAt: now + Math.max(FETCH_TIMEOUT_MS, HTML_NEGATIVE_CACHE_TTL_MS) });
  return pending;
}

async function fetchHtmlUncached(value, timeout = FETCH_TIMEOUT_MS) {
  let url;
  try {
    url = new URL(value);
    assertSafePublicUrl(url);
  } catch {
    return null;
  }
  try {
    const response = await fetch(url, {
      dispatcher,
      redirect: "follow",
      signal: AbortSignal.timeout(Math.min(timeout, FETCH_TIMEOUT_MS)),
      headers: browserHeaders(),
    });
    if (!response.ok) {
      await cancelResponseBody(response);
      return null;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      await cancelResponseBody(response);
      return null;
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > 2_000_000) {
      await cancelResponseBody(response);
      return null;
    }
    const html = (await response.text()).slice(0, 2_000_000);
    const finalUrl = new URL(response.url);
    assertSafePublicUrl(finalUrl);
    return {
      url: finalUrl.toString(),
      html,
      title: cleanText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""),
      description: cleanText(
        html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']*)/i)?.[1] ?? "",
      ),
    };
  } catch {
    return null;
  }
}

function scoreSearchCandidate(entity, candidate) {
  const haystack = normalizeText(`${candidate.title} ${candidate.snippet}`);
  const identity = entityIdentity(entity.entity_name);
  let score = candidate.officialBadge ? 20 : 0;
  if (identity.core && containsNormalizedToken(haystack, normalizeText(identity.core))) score += 38;
  const matched = identity.tokens.filter((token) => containsNormalizedToken(haystack, token)).length;
  if (identity.tokens.length) score += Math.round(28 * matched / identity.tokens.length);
  try {
    const host = new URL(candidate.url).hostname.toLowerCase();
    if (identity.domainTokens.some((token) => host.replace(/[^a-z0-9]/g, "").includes(token))) score += 22;
    if (/\.(?:gov|edu)(?:\.[a-z]{2})?$/i.test(host)) score += 8;
  } catch {
    return 0;
  }
  if (/official|官网|官方网站/i.test(`${candidate.title} ${candidate.snippet}`)) score += 8;
  return Math.min(score, 70);
}

function scoreIdentityMatch(entity, pageText, pageUrl) {
  const identity = entityIdentity(entity.entity_name);
  const haystack = normalizeText(pageText);
  let score = 0;
  if (identity.core && containsNormalizedToken(haystack, normalizeText(identity.core))) score += 35;
  const matched = identity.tokens.filter((token) => containsNormalizedToken(haystack, token)).length;
  if (identity.tokens.length) score += Math.round(30 * matched / identity.tokens.length);
  const host = new URL(pageUrl).hostname.toLowerCase();
  const compactHost = host.replace(/[^a-z0-9]/g, "");
  const hostMatches = identity.domainTokens.filter((token) => compactHost.includes(token)).length;
  if (hostMatches) score += 18;
  if (/\.(?:gov|edu)(?:\.[a-z]{2})?$/i.test(host)
    && /高校|科研机构|政府|政策|项目/.test(entity.entity_type)) score += 12;
  const hints = contextTokens(entity);
  const contextMatches = hints.filter((token) => containsNormalizedToken(haystack, token)).length;
  score += Math.min(contextMatches * 8, 16);
  const requiresContext = entity.entity_type === "人物"
    || (!hasHan(entity.entity_name) && identity.tokens.length <= 1 && normalizeText(entity.entity_name).length <= 8);
  const requiresHostMatch = !hasHan(entity.entity_name)
    && identity.tokens.length <= 1
    && normalizeText(canonicalEntityName(entity.entity_name)).length <= 10;
  return {
    score: Math.min(score, 50),
    contextMatches,
    requiresContext,
    hostMatches,
    requiresHostMatch,
    tokens: identity.tokens,
    domainTokens: identity.domainTokens,
  };
}

function entityIdentity(name) {
  const canonical = canonicalEntityName(name);
  const core = canonical.replace(/博士|教授/g, "").trim();
  const latinTokens = normalizeText(canonical).split(" ").filter((token) =>
    token.length >= 3 && !GENERIC_TOKENS.has(token) && !/^\d+$/.test(token),
  );
  const domainTokens = latinTokens.map((token) => token.replace(/[^a-z0-9]/g, "")).filter((token) => token.length >= 4);
  return {
    core: hasHan(core) && !/[A-Za-z]{2,}/.test(core) && core.length >= 2 ? core : "",
    tokens: /[A-Za-z]{2,}/.test(name) ? latinTokens : [normalizeText(core)].filter(Boolean),
    domainTokens,
  };
}

function buildQuery(entity) {
  const canonical = canonicalEntityName(entity.entity_name);
  const hasLatinName = /[A-Za-z]{2,}/.test(canonical);
  const routeTerms = {
    accelerator: "news incubator accelerator",
    enterprise: "news press release",
    university: "research news technology transfer",
    research: "research news press release",
    public: "official news policy announcement",
    generic: "news press release",
  };
  const routeTerm = routeTerms[entity.route_kind] || routeTerms.generic;
  const searchName = hasLatinName
    ? canonical.replace(/[\u3400-\u9fff（）]/g, " ").replace(/\s+/g, " ").trim()
    : canonical;
  const suffix = !hasLatinName && /[\u3400-\u9fff]/.test(entity.entity_name)
    ? "官网"
    : entity.entity_type === "人物"
      ? "official profile"
      : `official website ${routeTerm}`;
  const location = [entity.city, entity.region]
    .filter((value) => value && !/未标注|T\d+/.test(value))
    .slice(0, 1)
    .join(" ");
  const context = contextTokens(entity)
    .filter((token) => !hasLatinName || /[a-z]/i.test(token))
    .slice(0, 3)
    .join(" ");
  return `${searchName} ${context} ${location} ${suffix}`.replace(/\s+/g, " ").trim();
}

function contextTokens(entity) {
  const nameTokens = new Set(normalizeText(entity.entity_name).split(" "));
  const tokens = normalizeText(entity.summary ?? "").split(" ").filter((token) =>
    token.length >= 3
    && !nameTokens.has(token)
    && !GENERIC_TOKENS.has(token)
    && !/(?:实体|收录|报告|案例)/.test(token)
    && !/^(?:报告|实体|收录于报告|人物|企业|机构|案例|标杆|未标注|p\d+|t\d+|r\d+|c\d+)$/i.test(token),
  );
  return [...new Set(tokens)].slice(0, 8);
}

function canonicalEntityName(name) {
  let value = name
    .replace(/\s*[（(][^）)]*[）)]\s*/g, " ")
    .replace(/(?:博士|教授)\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/^[A-Za-z0-9&.'’+\- ]{3,}/.test(value)) {
    value = value.match(/^[A-Za-z0-9&.'’+\- ]{3,}/)?.[0]?.trim() ?? value;
  }
  return value.replace(/\b(?:20\d{2}年?).*$/u, "").trim();
}

function normalizeTitle(value) {
  return value.replace(/_/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function containsNormalizedToken(haystack, token) {
  if (!token) return false;
  if (hasHan(token)) return haystack.includes(token);
  return ` ${haystack} `.includes(` ${token} `);
}

function browserHeaders() {
  return {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
    accept: "text/html,application/xhtml+xml",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
  };
}

function normalizeCandidateUrl(value) {
  if (!value) return "";
  if (/\.\.\.|…/.test(value)) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (url.protocol === "http:") url.protocol = "https:";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function isRejectedUrl(value) {
  try {
    const url = new URL(value);
    return REJECT_HOSTS.test(url.hostname) || /\.(?:pdf|docx?|pptx?|xlsx?|zip)$/i.test(url.pathname);
  } catch {
    return true;
  }
}

function assertSafePublicUrl(url) {
  if (url.protocol !== "https:") throw new Error("only HTTPS sources are allowed");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" || host === "::1" || host.endsWith(".local")
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^(?:fc|fd|fe8|fe9|fea|feb)/i.test(host)
  ) throw new Error("private source blocked");
}

function siteKey(hostname) {
  const labels = hostname.toLowerCase().replace(/^www\./, "").split(".");
  const lastTwo = labels.slice(-2).join(".");
  return /^(?:co\.uk|com\.au|co\.nz|com\.br|edu\.cn|gov\.cn)$/.test(lastTwo)
    ? labels.slice(-3).join(".")
    : lastTwo;
}

function cleanText(value) {
  return decodeHtml(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function decodeHtml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function normalizeText(value) {
  return cleanText(value).toLowerCase().normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function hasHan(value) {
  return /[\u3400-\u9fff]/.test(value);
}

function throttleSearch() {
  const next = searchGate.then(() => new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS)));
  searchGate = next.catch(() => {});
  return next;
}

function throttleAiReview() {
  const next = aiReviewGate.then(() => new Promise((resolve) => setTimeout(resolve, 600)));
  aiReviewGate = next.catch(() => {});
  return next;
}

function throttleAiSearch() {
  const next = aiSearchGate.then(() => new Promise((resolve) => setTimeout(resolve, 350)));
  aiSearchGate = next.catch(() => {});
  return next;
}

function withTimeout(promise, timeoutMs, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(typeof fallback === "function" ? fallback() : fallback), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function postResults(results) {
  const response = await fetch(`${baseUrl}/api/news/discovery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ results }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new Error(`discovery ingest HTTP ${response.status}`);
  }
  await consumeResponseBody(response);
}

async function recordRun(stats) {
  const response = await fetch(`${baseUrl}/api/news/discovery`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...stats,
      errorSummary: stats.errors.slice(-8).join("\n"),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new Error(`discovery run record HTTP ${response.status}`);
  }
  await consumeResponseBody(response);
}

function updateStats(stats, result) {
  if (result.status === "news_verified") {
    stats.newsVerified += 1;
    stats.officialVerified += 1;
  } else if (result.status === "official_verified") stats.officialVerified += 1;
  else if (result.status === "candidate") stats.candidatesFound += 1;
  else if (result.status === "not_found") stats.notFound += 1;
  else if (result.status === "not_applicable") stats.notApplicable += 1;
  else if (result.status === "failed") {
    stats.failureCount += 1;
    if (result.error) stats.errors.push(`${result.entityName}: ${result.error}`);
  }
}

async function waitForApp() {
  // The request-poll runner is started alongside the Worker by the PowerShell
  // launcher. Keep waiting through a slow first build so queued manual runs
  // are not stranded when the Worker takes longer than 30 seconds to boot.
  const maxAttempts = requestPollOnly ? Number.POSITIVE_INFINITY : 30;
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      const response = await fetch(`${baseUrl}/api/news/discovery`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        await consumeResponseBody(response);
        return;
      }
      await cancelResponseBody(response);
    } catch {
      // App is still starting.
    }
    attempt += 1;
    if (requestPollOnly && attempt % 30 === 0) {
      console.log(JSON.stringify({ event: "source-discovery-waiting-for-app", attempts: attempt }));
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("local app did not become ready for discovery");
}

function formatError(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause && typeof cause === "object") {
    const code = typeof cause.code === "string" ? cause.code : "";
    const message = typeof cause.message === "string" ? cause.message : "";
    if (code || message) return `${error.message}${code ? ` (${code})` : ""}${message ? `: ${message}` : ""}`;
  }
  return error.message;
}

async function consumeResponseBody(response) {
  try {
    await response.arrayBuffer();
  } catch {
    // The caller already has the HTTP status; draining is best effort.
  }
}

async function cancelResponseBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The connection may already be closed.
  }
}

function acquireLock() {
  if (existsSync(lockPath)) {
    const existingPid = Number(readFileSync(lockPath, "utf8"));
    try {
      process.kill(existingPid, 0);
      console.log(JSON.stringify({ event: "source-discovery-already-running", pid: existingPid }));
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
    if (existsSync(lockPath) && Number(readFileSync(lockPath, "utf8")) === process.pid) unlinkSync(lockPath);
  } catch {
    // Best-effort cleanup.
  }
  void dispatcher?.close();
}
