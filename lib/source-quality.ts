type OrganizationIdentity = { name: string; aliases?: string[] };

type Candidate = { url: string; title?: string; content?: string };

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
import { fetchExternalUrl } from "./security-url";
import { fetchControlled } from "./http-control";

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

const GENERIC_TERMS = new Set(["university", "institute", "institution", "college", "school", "academy", "center", "centre", "official", "the"]);

function coreTerms(identity: OrganizationIdentity): string[] {
  return identityTerms(identity).flatMap((term) => {
    const words = term.split(" ").filter((word) => word.length >= 3 && !GENERIC_TERMS.has(word));
    return [term, ...words];
  });
}

function hasEvidence(text: string, identity: OrganizationIdentity): boolean {
  const normalized = normalize(text);
  const compactText = normalized.replace(/\s+/g, "");
  return identityTerms(identity).some((term) => normalized.includes(term) || compactText.includes(compact(term)));
}

function hasCoreEvidence(text: string, identity: OrganizationIdentity): boolean {
  const normalized = normalize(text);
  const compactText = normalized.replace(/\s+/g, "");
  return coreTerms(identity).some((term) => normalized.includes(term) || compactText.includes(compact(term)));
}

function failure(identity: OrganizationIdentity, value: string, reason: string): false {
  console.warn(`[验证失败] 机构 ${identity.name}, URL: ${value}, 原因: ${reason}`);
  return false;
}

function isObviousSpam(hostname: string, body: string): boolean {
  const host = hostname.toLocaleLowerCase();
  return /(?:^|\.)(?:blog|forum|bbs|medium|wordpress|zhihu|reddit|quora)\./i.test(host)
    || /(?:powered by wordpress|论坛|博客|讨论区|sign in to continue)/i.test(body);
}

function metaDescription(html: string): string {
  return [...html.matchAll(/<meta\b[^>]*>/gi)].flatMap((match) => {
    const tag = match[0];
    const name = tag.match(/\b(?:name|property)=["']([^"']+)["']/i)?.[1]?.toLocaleLowerCase();
    return name === "description" || name === "og:description" ? [tag.match(/\bcontent=["']([^"']*)["']/i)?.[1] || ""] : [];
  }).join(" ");
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
    try { await reader.cancel(); } catch { /* response may already be complete */ }
    reader.releaseLock();
  }
}

export async function verifyCandidateHomepage(
  value: string,
  identity: OrganizationIdentity,
  options: { fetchImpl?: FetchLike; timeoutMs?: number; maxRedirects?: number; loose?: boolean } = {},
): Promise<boolean> {
  let current: URL;
  try {
    current = new URL(value);
  } catch {
    return failure(identity, value, "URL 无效");
  }
  if (current.protocol !== "https:" && current.protocol !== "http:") return failure(identity, value, "不支持的协议");
  const fetchImpl = options.fetchImpl || (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => fetchExternalUrl(String(input), {
    fetchImpl: (request, requestInit) => fetchControlled(request, requestInit, options.timeoutMs ?? 10_000),
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
    } catch (error) {
      return failure(identity, current.toString(), `请求失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) { try { await response.body?.cancel(); } catch (error) { console.warn(`[source-quality] response cleanup failed: ${error instanceof Error ? error.message : String(error)}`); } return failure(identity, current.toString(), "重定向缺少 Location"); }
      try {
        current = new URL(location, current);
      } catch {
        return failure(identity, current.toString(), "重定向 URL 无效");
      }
      if (current.protocol !== "https:" && current.protocol !== "http:") return failure(identity, current.toString(), "重定向到不支持的协议");
      continue;
    }
    if (!response.ok) { try { await response.body?.cancel(); } catch (error) { console.warn(`[source-quality] response cleanup failed: ${error instanceof Error ? error.message : String(error)}`); } return failure(identity, current.toString(), `HTTP ${response.status}`); }
    const contentType = response.headers.get("content-type") || "";
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) { try { await response.body?.cancel(); } catch (error) { console.warn(`[source-quality] response cleanup failed: ${error instanceof Error ? error.message : String(error)}`); } return failure(identity, current.toString(), `非 HTML 内容类型: ${contentType}`); }
    let body: string;
    try {
      body = await readLimited(response);
    } catch (error) {
      return failure(identity, current.toString(), `读取页面失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    const visible = body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
    if (isObviousSpam(current.hostname, visible)) return failure(identity, current.toString(), "疑似博客/论坛等垃圾站点");
    if (hasEvidence(visible, identity) || hasEvidence(body, identity)) return true;
    const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
    const descriptions = metaDescription(body);
    if (options.loose === true && hasCoreEvidence(`${title} ${descriptions}`, identity)) return true;
    // Some legitimate institutional homepages are client-rendered and expose
    // little text to a crawler. Accept a matching host plus an institutional
    // marker instead of rejecting them solely on DOM text extraction.
    const hostMatches = domainHasKeyword(current.hostname, identity);
    const institutionalMarker = /university|institute|college|school|academy|官方|大学|学院|研究所|研究院/i.test(visible);
    if (hostMatches && institutionalMarker) return true;
    return failure(identity, current.toString(), "未找到机构名或核心关键词");
  }
  return failure(identity, current.toString(), "超过最大重定向次数");
}
