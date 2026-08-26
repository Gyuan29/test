
type FetchOptions = { fetchImpl?: typeof fetch; timeoutMs?: number; maxRedirects?: number; headers?: HeadersInit };

function isPrivateIp(value: string): boolean {
  const normalized = value.toLowerCase();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (normalized.includes(":")) return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  return false;
}

export function validateExternalUrl(value: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try { url = new URL(value); } catch { return { ok: false, reason: "invalid_url" }; }
  if (!/^https?:$/.test(url.protocol)) return { ok: false, reason: "unsupported_protocol" };
  if (url.username || url.password) return { ok: false, reason: "credentials_not_allowed" };
  if (isPrivateIp(url.hostname.replace(/^\[|\]$/g, ""))) return { ok: false, reason: "private_address" };
  return { ok: true, url };
}

async function resolvesPublicHost(hostname: string): Promise<boolean> {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) return !isPrivateIp(hostname);
  if (typeof process === "undefined" || !process.versions?.node) return true;
  try {
    const dns = await import("node:dns/promises");
    const records = await dns.lookup(hostname, { all: true });
    return records.length > 0 && records.every((record) => !isPrivateIp(record.address));
  } catch { return false; }
}

export async function fetchExternalUrl(value: string, options: FetchOptions = {}): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? 3;
  let current = validateExternalUrl(value);
  if (!current.ok || !(await resolvesPublicHost(current.url.hostname))) return new Response("blocked", { status: 400 });
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const response = await fetchImpl(current.url, { redirect: "manual", headers: options.headers, signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    const next = validateExternalUrl(new URL(location, current.url).toString());
    if (!next.ok || !(await resolvesPublicHost(next.url.hostname))) return new Response("blocked redirect", { status: 502 });
    current = next;
  }
  return new Response("too many redirects", { status: 502 });
}
