import { Agent, fetch as undiciFetch } from "undici";

const envInt = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};
const MAX_ACTIVE_REQUESTS = envInt("MAX_ACTIVE_REQUESTS", 50);
const MAX_CONNECTIONS = envInt("HTTP_MAX_CONNECTIONS", 20);
const KEEP_ALIVE_TIMEOUT_MS = envInt("HTTP_KEEP_ALIVE_TIMEOUT_MS", 5_000);
const DEFAULT_TIMEOUT_MS = envInt("HTTP_TIMEOUT_MS", 10_000);
const ALLOW_INSECURE_SSL = /^(1|true|yes)$/i.test(process.env.ALLOW_INSECURE_SSL?.trim() || "false");

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

function requestUrl(input: RequestInfo | URL): URL | null { try { return new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url); } catch { return null; } }
function isSearxngUrl(url: URL | null): boolean { if (!url) return false; const configured = (process.env.SEARXNG_URLS || process.env.SEARXNG_URL || "http://localhost:8080").split(",").map((value) => value.trim()).filter(Boolean); return configured.some((value) => { try { return new URL(value).origin === url.origin; } catch { return false; } }); }
function requestHeaders(input: RequestInfo | URL, headers?: HeadersInit): Headers {
  const url = requestUrl(input); const merged = new Headers(BROWSER_HEADERS); merged.set("user-agent", randomUserAgent()); if (url) merged.set("referer", `${url.origin}/`);
  new Headers(headers).forEach((value, key) => merged.set(key, value));
  const cookie = cookieValue(isSearxngUrl(url) ? process.env.SEARXNG_COOKIE : process.env.GLOBAL_COOKIE);
  if (cookie && !merged.has("cookie")) merged.set("cookie", cookie);
  return merged;
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
  while (activeRequests >= MAX_ACTIVE_REQUESTS) await new Promise((resolve) => setTimeout(resolve, 100));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timeout after ${timeoutMs}ms`)), timeoutMs);
  const upstreamSignal = init.signal;
  const abortUpstream = () => controller.abort(upstreamSignal?.reason);
  upstreamSignal?.addEventListener("abort", abortUpstream, { once: true });
  activeRequests += 1;
  try {
    return await undiciFetch(input as string | URL, { ...init, headers: requestHeaders(input, init.headers), signal: controller.signal, dispatcher: pipelineAgent } as never) as unknown as Response;
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
