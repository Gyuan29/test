import { Agent, fetch as undiciFetch } from "undici";
import { CONFIG } from "./config";

const MAX_ACTIVE_REQUESTS = CONFIG.MAX_ACTIVE_REQUESTS;
const MAX_CONNECTIONS = CONFIG.HTTP_MAX_CONNECTIONS;
const KEEP_ALIVE_TIMEOUT_MS = CONFIG.HTTP_KEEP_ALIVE_TIMEOUT_MS;
const DEFAULT_TIMEOUT_MS = CONFIG.HTTP_TIMEOUT_MS;
const CONNECT_TIMEOUT_MS = CONFIG.HTTP_CONNECT_TIMEOUT_MS;
const ALLOW_INSECURE_SSL = CONFIG.ALLOW_INSECURE_SSL;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
] as const;
const BROWSER_HEADERS: Record<string, string> = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
  "accept-encoding": "gzip, deflate, br",
};

function randomUserAgent(): string { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] || USER_AGENTS[0]; }

function cookieValue(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const parts = value.split(";").map((part) => part.trim()).filter(Boolean);
  const valid = parts.flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator <= 0) return [];
    const name = part.slice(0, separator).trim(); const raw = part.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n;]/.test(raw)) return [];
    const encoded = raw.replace(/[^\x21-\x7e]/g, (character) => encodeURIComponent(character));
    return [`${name}=${encoded}`];
  });
  return valid.length === parts.length ? valid.join("; ") : undefined;
}

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  expiresAt?: number;
}

/** Small in-memory cookie store for the pipeline's server-side requests. */
export class CookieJar {
  private readonly cookies = new Map<string, StoredCookie>();

  setCookie(domain: string, cookieString: string): void {
    const rawDomain = domain.trim();
    const requestDomain = this.normalizeDomain(rawDomain);
    if (!requestDomain) return;
    const parts = cookieString.split(";").map((part) => part.trim()).filter(Boolean);
    const first = parts.shift();
    if (!first) return;
    const separator = first.indexOf("=");
    if (separator <= 0) return;
    const name = first.slice(0, separator).trim();
    const value = first.slice(separator + 1).trim();
    if (!this.validCookieName(name) || /[\r\n;]/.test(value)) return;

    let cookieDomain = requestDomain;
    let hostOnly = !rawDomain.startsWith(".");
    let expiresAt: number | undefined;
    let deleteCookie = false;
    for (const attribute of parts) {
      const attributeSeparator = attribute.indexOf("=");
      const attributeName = (attributeSeparator >= 0 ? attribute.slice(0, attributeSeparator) : attribute).trim().toLowerCase();
      const attributeValue = attributeSeparator >= 0 ? attribute.slice(attributeSeparator + 1).trim() : "";
      if (attributeName === "domain") {
        const parsedDomain = this.normalizeDomain(attributeValue);
        if (!parsedDomain || (parsedDomain !== requestDomain && !requestDomain.endsWith(`.${parsedDomain}`))) return;
        cookieDomain = parsedDomain;
        hostOnly = false;
      } else if (attributeName === "max-age") {
        const seconds = Number(attributeValue);
        if (Number.isFinite(seconds)) {
          if (seconds <= 0) deleteCookie = true;
          else expiresAt = Date.now() + seconds * 1000;
        }
      } else if (attributeName === "expires") {
        const timestamp = Date.parse(attributeValue);
        if (Number.isFinite(timestamp)) {
          expiresAt = timestamp;
          if (timestamp <= Date.now()) deleteCookie = true;
        }
      }
    }

    const key = `${cookieDomain}|${name}`;
    if (deleteCookie || (expiresAt !== undefined && expiresAt <= Date.now())) {
      this.cookies.delete(key);
      return;
    }
    this.cookies.set(key, { name, value, domain: cookieDomain, hostOnly, expiresAt });
  }

  getCookie(domain: string): string | undefined {
    const requestDomain = this.normalizeDomain(domain);
    if (!requestDomain) return undefined;
    const now = Date.now();
    const matching: StoredCookie[] = [];
    for (const [key, cookie] of this.cookies) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
        this.cookies.delete(key);
        continue;
      }
      const matches = cookie.hostOnly
        ? cookie.domain === requestDomain
        : requestDomain === cookie.domain || requestDomain.endsWith(`.${cookie.domain}`);
      if (matches) matching.push(cookie);
    }
    return matching.length > 0 ? matching.map(({ name, value }) => `${name}=${value}`).join("; ") : undefined;
  }

  private normalizeDomain(domain: string): string | undefined {
    const normalized = domain.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
    return normalized && /^[a-z0-9.-]+$/.test(normalized) ? normalized : undefined;
  }

  private validCookieName(name: string): boolean {
    return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);
  }
}

export const cookieJar = new CookieJar();

function mergeCookieValues(...values: Array<string | undefined>): string | undefined {
  const merged = new Map<string, string>();
  for (const value of values) {
    const normalized = cookieValue(value);
    if (!normalized) continue;
    for (const part of normalized.split("; ")) {
      const separator = part.indexOf("=");
      if (separator > 0) merged.set(part.slice(0, separator), part.slice(separator + 1));
    }
  }
  return merged.size > 0 ? Array.from(merged, ([name, value]) => `${name}=${value}`).join("; ") : undefined;
}

function requestUrl(input: RequestInfo | URL): URL | null { try { return new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url); } catch { return null; } }
function isSearxngUrl(url: URL | null): boolean { if (!url) return false; const configured = (CONFIG.SEARXNG_URLS || CONFIG.SEARXNG_URL).split(",").map((value) => value.trim()).filter(Boolean); return configured.some((value) => { try { return new URL(value).origin === url.origin; } catch { return false; } }); }
function requestHeaders(input: RequestInfo | URL, headers?: HeadersInit): Headers {
  const url = requestUrl(input); const merged = new Headers(BROWSER_HEADERS); merged.set("user-agent", randomUserAgent()); if (url) merged.set("referer", `${url.origin}/`);
  new Headers(headers).forEach((value, key) => merged.set(key, value));
  if (url) {
    const configuredCookie = merged.has("cookie")
      ? merged.get("cookie") || undefined
      : isSearxngUrl(url) ? CONFIG.SEARXNG_COOKIE : CONFIG.GLOBAL_COOKIE;
    const cookie = mergeCookieValues(cookieJar.getCookie(url.hostname), configuredCookie);
    if (cookie) merged.set("cookie", cookie);
  }
  return merged;
}

function responseSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const value = headers.get("set-cookie");
  // Older fetch implementations fold repeated Set-Cookie headers into one line.
  return value ? value.split(/,(?=\s*[^;,=\s]+\s*=)/) : [];
}

export function formatRequestError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause && typeof cause === "object") {
    const details = cause as { code?: unknown; errno?: unknown; message?: unknown };
    const code = typeof details.code === "string" ? details.code : typeof details.errno === "string" ? details.errno : "";
    const message = typeof details.message === "string" ? details.message : "";
    if (code || message) return `${error.message}${code ? ` [${code}]` : ""}${message && message !== error.message ? `: ${message}` : ""}`;
  }
  return error.message;
}

// Keep one bounded pool for all pipeline HTTP traffic. Undici uses `connections`
// as the per-origin equivalent of Node's `maxSockets`.
export const pipelineAgent = new Agent({
  connections: MAX_CONNECTIONS,
  connectTimeout: CONNECT_TIMEOUT_MS,
  keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
  keepAliveMaxTimeout: KEEP_ALIVE_TIMEOUT_MS,
  connect: { rejectUnauthorized: !ALLOW_INSECURE_SSL },
});

export async function closePipelineAgent(): Promise<void> {
  try { await pipelineAgent.close(); } catch { /* in-flight requests are already being aborted */ }
}

let activeRequests = 0;

export function activeSocketCount(): number {
  return activeRequests;
}

export function logActiveSockets(context: string): void {
  const active = activeSocketCount();
  console.log(`[监控] 当前活跃 Socket 数: ${active} (${context})`);
  if (active > MAX_ACTIVE_REQUESTS) console.warn(`[监控] 活跃 Socket 超过 ${MAX_ACTIVE_REQUESTS}，暂停新请求直到连接释放`);
}

export async function fetchControlled(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const waitStartedAt = Date.now();
  while (activeRequests >= MAX_ACTIVE_REQUESTS) {
    if (Date.now() - waitStartedAt >= timeoutMs) throw new Error(`request queue timeout after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timeout after ${timeoutMs}ms`)), timeoutMs);
  const upstreamSignal = init.signal;
  const abortUpstream = () => controller.abort(upstreamSignal?.reason);
  upstreamSignal?.addEventListener("abort", abortUpstream, { once: true });
  activeRequests += 1;
  try {
    const response = await undiciFetch(input as string | URL, { ...init, headers: requestHeaders(input, init.headers), signal: controller.signal, dispatcher: pipelineAgent } as never) as unknown as Response;
    const url = requestUrl(input);
    if (url) for (const setCookie of responseSetCookies(response)) cookieJar.setCookie(url.hostname, setCookie);
    return response;
  } catch (error) {
    controller.abort();
    console.error(`[http] request failed ${String(input)}: ${formatRequestError(error)}`);
    throw error;
  } finally {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", abortUpstream);
    activeRequests = Math.max(0, activeRequests - 1);
  }
}

export async function cancelResponseBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* response may already be fully consumed */ }
}

export function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = () => {
    active -= 1;
    queue.shift()?.();
  };
  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= concurrency) await new Promise<void>((resolve) => queue.push(resolve));
      active += 1;
      try { return await task(); } finally { release(); }
    },
  };
}
