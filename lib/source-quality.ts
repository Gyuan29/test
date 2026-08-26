type OrganizationIdentity = { name: string; aliases?: string[] };

type Candidate = { url: string; title?: string; content?: string };

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
import { fetchExternalUrl } from "./security-url";

const MAX_HOME_PAGE_BYTES = 512 * 1024;

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\u3400-\u9fff]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compact(value: string): string {
  return normalize(value).replace(/\s+/g, "");
}

function identityTerms(identity: OrganizationIdentity): string[] {
  return [identity.name, ...(identity.aliases || [])]
    .map((value) => normalize(value))
    .filter((value) => value.length >= 2);
}

function hasEvidence(text: string, identity: OrganizationIdentity): boolean {
  const normalized = normalize(text);
  const compactText = normalized.replace(/\s+/g, "");
  return identityTerms(identity).some((term) => normalized.includes(term) || compactText.includes(compact(term)));
}

function domainHasKeyword(hostname: string, identity: OrganizationIdentity): boolean {
  const host = hostname.toLocaleLowerCase().replace(/^www\./, "");
  const compactHost = host.replace(/[^a-z0-9]/g, "");
  const terms = identityTerms(identity)
    .flatMap((term) => [term, compact(term), ...term.split(" ")])
    .map((term) => term.replace(/[^a-z0-9]/g, ""))
    .filter((term) => term.length >= 3);
  return terms.some((term) => compactHost.includes(term));
}

export function isStrictCandidate(candidate: Candidate, identity: OrganizationIdentity): boolean {
  let url: URL;
  try {
    url = new URL(candidate.url);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (!domainHasKeyword(url.hostname, identity)) return false;
  return hasEvidence(`${candidate.title || ""} ${candidate.content || ""}`, identity);
}

async function readLimited(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (declaredLength > MAX_HOME_PAGE_BYTES) throw new Error("response_too_large");
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const decoder = new TextDecoder();
  let total = 0;
  let body = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_HOME_PAGE_BYTES) throw new Error("response_too_large");
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    reader.releaseLock();
  }
}

export async function verifyCandidateHomepage(
  value: string,
  identity: OrganizationIdentity,
  options: { fetchImpl?: FetchLike; timeoutMs?: number; maxRedirects?: number } = {},
): Promise<boolean> {
  let current: URL;
  try {
    current = new URL(value);
  } catch {
    return false;
  }
  if (current.protocol !== "https:" && current.protocol !== "http:") return false;
  const fetchImpl = options.fetchImpl || (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => fetchExternalUrl(String(input), {
    headers: init?.headers,
    timeoutMs: options.timeoutMs ?? 10_000,
    maxRedirects: options.maxRedirects ?? 2,
  }));
  const maxRedirects = options.maxRedirects ?? 2;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        headers: { accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch {
      return false;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return false;
      try {
        current = new URL(location, current);
      } catch {
        return false;
      }
      if (current.protocol !== "https:" && current.protocol !== "http:") return false;
      continue;
    }
    if (!response.ok) return false;
    const contentType = response.headers.get("content-type") || "";
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) return false;
    let body: string;
    try {
      body = await readLimited(response);
    } catch {
      return false;
    }
    const visible = body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
    return hasEvidence(visible, identity) || hasEvidence(body, identity);
  }
  return false;
}
