import { Agent, fetch as undiciFetch } from "undici";

const envInt = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};
const MAX_ACTIVE_REQUESTS = envInt("MAX_ACTIVE_REQUESTS", 50);
const MAX_CONNECTIONS = envInt("HTTP_MAX_CONNECTIONS", 20);
const KEEP_ALIVE_TIMEOUT_MS = envInt("HTTP_KEEP_ALIVE_TIMEOUT_MS", 5_000);
const DEFAULT_TIMEOUT_MS = envInt("HTTP_TIMEOUT_MS", 10_000);

// Keep one bounded pool for all pipeline HTTP traffic. Undici uses `connections`
// as the per-origin equivalent of Node's `maxSockets`.
export const pipelineAgent = new Agent({
  connections: MAX_CONNECTIONS,
  keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
  keepAliveMaxTimeout: KEEP_ALIVE_TIMEOUT_MS,
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
    return await undiciFetch(input as string | URL, { ...init, signal: controller.signal, dispatcher: pipelineAgent } as never) as unknown as Response;
  } catch (error) {
    controller.abort();
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
