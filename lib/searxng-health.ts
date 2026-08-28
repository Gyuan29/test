import { cancelResponseBody, fetchControlled } from "./http-control";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type SearxngHealth = { ok: boolean; reason?: string };

export async function checkSearxngHealth(baseUrl: string, options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<SearxngHealth> {
  const fetchImpl = options.fetchImpl || ((input: RequestInfo | URL, init?: RequestInit) => fetchControlled(input, init, options.timeoutMs ?? 10_000));
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/search?q=${encodeURIComponent('"Bar-Ilan University" official website')}&format=json&categories=general`;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, { method: "GET", redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
  } catch {
    return { ok: false, reason: "request_failed" };
  }
  if (!response.ok) { await cancelResponseBody(response); return { ok: false, reason: "http_error" }; }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    await cancelResponseBody(response);
    return { ok: false, reason: "invalid_json" };
  }
  await cancelResponseBody(response);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { results?: unknown }).results)) return { ok: false, reason: "missing_results" };
  const results = (parsed as { results: unknown[] }).results;
  const relevant = results.some((result) => {
    if (!result || typeof result !== "object") return false;
    const item = result as { title?: unknown; content?: unknown; url?: unknown };
    const text = [item.title, item.content, item.url].filter((value): value is string => typeof value === "string").join(" ").toLocaleLowerCase();
    return text.includes("bar-ilan university") || /\bbiu\b/i.test(text);
  });
  return relevant ? { ok: true } : { ok: false, reason: "irrelevant_results" };
}
