type IntOptions = { min?: number; max?: number };

function envInt(name: string, fallback: number, options: IntOptions = {}): number {
  const value = Number(process.env[name]);
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes"].includes(value)) return true;
  if (["0", "false", "no"].includes(value)) return false;
  return fallback;
}

function envString(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export const CONFIG = Object.freeze({
  LOCAL_SQLITE_PATH: envString("LOCAL_SQLITE_PATH", ""),
  LOCAL_AUTH_SQLITE_PATH: envString("LOCAL_AUTH_SQLITE_PATH", "./.local/auth.sqlite"),
  DEBUG_LLM_FULL_OUTPUT: envBool("DEBUG_LLM_FULL_OUTPUT", false),
  ALLOW_INSECURE_SSL: envBool("ALLOW_INSECURE_SSL", false),
  NEWS_REQUEST_TIMEOUT_MS: envInt("NEWS_REQUEST_TIMEOUT_MS", 20_000, { min: 1_000 }),
  NEWS_EXTRACTOR_TIMEOUT_MS: envInt("NEWS_EXTRACTOR_TIMEOUT_MS", 20_000, { min: 1_000 }),
  HTTP_TIMEOUT_MS: envInt("HTTP_TIMEOUT_MS", 20_000, { min: 1_000 }),
  HTTP_CONNECT_TIMEOUT_MS: envInt("HTTP_CONNECT_TIMEOUT_MS", 20_000, { min: 1_000 }),
  HTTP_KEEP_ALIVE_TIMEOUT_MS: envInt("HTTP_KEEP_ALIVE_TIMEOUT_MS", 5_000, { min: 500 }),
  LLM_TIMEOUT_MS: envInt("LLM_TIMEOUT_MS", 60_000, { min: 1_000 }),
  LLM_MAX_RETRIES: envInt("LLM_MAX_RETRIES", 0, { min: 0, max: 5 }),
  LLM_CONCURRENCY: envInt("LLM_CONCURRENCY", 3, { min: 1 }),
  SEARXNG_CONCURRENCY: envInt("SEARXNG_CONCURRENCY", 8, { min: 1 }),
  HOMEPAGE_CONCURRENCY: envInt("HOMEPAGE_CONCURRENCY", 4, { min: 1 }),
  NEWS_EXTRACTOR_CONCURRENCY: envInt("NEWS_EXTRACTOR_CONCURRENCY", 4, { min: 1 }),
  MAX_ACTIVE_REQUESTS: envInt("MAX_ACTIVE_REQUESTS", 50, { min: 1 }),
  HTTP_MAX_CONNECTIONS: envInt("HTTP_MAX_CONNECTIONS", 20, { min: 1 }),
  EXTRACTOR_RETRIES: envInt("EXTRACTOR_RETRIES", 2, { min: 0, max: 2 }),
  NEWS_MAX_RESULTS: envInt("NEWS_MAX_RESULTS", 20, { min: 1, max: 100 }),
  MAX_SOURCE_LINKS: envInt("NEWS_MAX_SOURCE_LINKS", 20, { min: 1, max: 100 }),
  NO_WEBSITE_MAX_RESULTS: envInt("NEWS_NO_WEBSITE_MAX_RESULTS", 10, { min: 1, max: 100 }),
  MAX_DEDUPE_RESULTS: envInt("NEWS_MAX_DEDUPE_RESULTS", 10, { min: 1, max: 100 }),
  MIN_RELEVANCE_SCORE: envInt("MIN_RELEVANCE_SCORE", 4, { min: 1, max: 10 }),
  MAX_RELEVANCE_SCORE: 10,
  EVENT_LOOKBACK_DAYS: envInt("EVENT_LOOKBACK_DAYS", 365, { min: 1 }),
  EXTRACTOR_MAX_CHARS: envInt("NEWS_EXTRACTOR_MAX_CHARS", 6_000, { min: 1_000, max: 8_000 }),
  EXTRACTOR_MIN_BODY_CHARS: envInt("NEWS_EXTRACTOR_MIN_BODY_CHARS", 160, { min: 40 }),
  ENABLE_NEWS_EXTRACTOR: envBool("ENABLE_NEWS_EXTRACTOR", false),
  MARKER_OUTPUT_INSTRUCTION: "Markers such as [FULL TEXT] and [SNIPPET MODE - LIMITED INFO] are input-only labels; never include them in the final JSON output.",
  RETRY_BACKOFF_MS: envInt("NEWS_RETRY_BACKOFF_MS", 250, { min: 0, max: 10_000 }),
  MILLISECONDS_PER_DAY: 86_400_000,
  SEARXNG_URL: envString("SEARXNG_URL", "http://localhost:8080"),
  SEARXNG_URLS: envString("SEARXNG_URLS", ""),
  SEARXNG_ENGINES: envString("SEARXNG_ENGINES", "google,bing,duckduckgo,baidu,startpage,qwant"),
  GLOBAL_COOKIE: envString("GLOBAL_COOKIE", ""),
  SEARXNG_COOKIE: envString("SEARXNG_COOKIE", ""),
  LLM_BASE_URL: envString("LLM_BASE_URL", "http://localhost:11434/v1"),
  LLM_API_KEY: envString("LLM_API_KEY", "ollama"),
  LLM_MODEL_NAME: envString("LLM_MODEL_NAME", "qwen2.5:3b"),
});

export type AppConfig = typeof CONFIG;
