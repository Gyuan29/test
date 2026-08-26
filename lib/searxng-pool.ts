import { checkSearxngHealth, type SearxngHealth } from "./searxng-health";

export type SearxngPoolResult = { url: string; title?: string; content?: string };

type HealthCheck = (baseUrl: string) => Promise<SearxngHealth>;
type Query = (baseUrl: string, query: string) => Promise<SearxngPoolResult[]>;

function normalizeBaseUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function parseSearxngUrls(env: { SEARXNG_URLS?: string; SEARXNG_URL?: string }): string[] {
  const configuredPool = env.SEARXNG_URLS?.split(",").map((value) => value.trim()).filter(Boolean) || [];
  const configured = configuredPool.length > 0 ? configuredPool : (env.SEARXNG_URL ? [env.SEARXNG_URL] : []);
  return [...new Set(configured.map(normalizeBaseUrl).filter((value): value is string => Boolean(value)))];
}

export async function checkSearxngPool(
  urls: string[],
  options: { healthCheck?: HealthCheck } = {},
): Promise<{ healthyUrls: string[]; failed: Array<{ url: string; reason: string }> }> {
  const healthCheck = options.healthCheck || checkSearxngHealth;
  const checks = await Promise.all(urls.map(async (url) => {
    try {
      const result = await healthCheck(url);
      return result.ok ? { url, ok: true as const } : { url, ok: false as const, reason: result.reason || "unhealthy" };
    } catch (error) {
      return { url, ok: false as const, reason: error instanceof Error ? error.message : "health_check_failed" };
    }
  }));
  return {
    healthyUrls: checks.filter((check): check is { url: string; ok: true } => check.ok).map((check) => check.url),
    failed: checks.filter((check): check is { url: string; ok: false; reason: string } => !check.ok).map(({ url, reason }) => ({ url, reason })),
  };
}

function canonicalResultUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export async function aggregateSearxngResults(
  healthyUrls: string[],
  query: string,
  options: { query: Query },
): Promise<SearxngPoolResult[]> {
  const responses = await Promise.allSettled(healthyUrls.map((url) => options.query(url, query)));
  const merged = new Map<string, SearxngPoolResult>();
  for (const response of responses) {
    if (response.status !== "fulfilled") continue;
    for (const item of response.value) {
      if (!item || typeof item.url !== "string") continue;
      const canonical = canonicalResultUrl(item.url);
      if (!canonical) continue;
      const existing = merged.get(canonical);
      merged.set(canonical, {
        url: canonical,
        title: existing?.title || item.title,
        content: existing?.content || item.content,
      });
    }
  }
  return [...merged.values()];
}
