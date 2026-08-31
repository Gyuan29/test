import { load } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { fetchExternalUrl } from "@/lib/security-url";
import { formatRequestError } from "@/lib/http-control";

export type ContentType = "text" | "image" | "video";

export interface ContentItem {
  type: ContentType;
  content: string;
  desc: string;
}

export interface NewsMetaInfo {
  author_name: string;
  author_url: string;
  publish_time: string;
}

export interface NewsItem {
  title: string;
  subtitle?: string | null;
  news_url: string;
  news_id: string;
  meta_info: NewsMetaInfo;
  contents: ContentItem[];
  texts: string[];
  images: string[];
  videos: string[];
  extra?: Record<string, unknown>;
}

export interface NewsSnippet {
  title?: string;
  summary?: string;
  publishedAt?: string;
  sourceName?: string;
}

export interface ExtractNewsOptions {
  html?: string;
  snippet?: NewsSnippet;
  timeoutMs?: number;
  retries?: number;
  platform?: string;
}

export type ExtractionMethod = "platform-rule" | "generic-rule" | "snippet-fallback";

export interface ExtractionResult {
  item: NewsItem;
  platform: string | null;
  method: ExtractionMethod;
  confidence: number;
  warnings: string[];
}

export class NewsExtractionError extends Error {
  constructor(message: string, public readonly code: "invalid_url" | "fetch_failed" | "parse_failed") {
    super(message);
    this.name = "NewsExtractionError";
  }
}

type Platform = "wechat" | "bbc" | "cnn" | "netease";

const PLATFORM_PATTERNS: Record<Platform, RegExp> = {
  wechat: /^https?:\/\/mp\.weixin\.qq\.com\/s\//i,
  bbc: /^https?:\/\/www\.bbc\.com\/news\/articles\//i,
  cnn: /^https?:\/\/(?:edition\.|www\.)?cnn\.com\/\d{4}\/\d{2}\/\d{2}\//i,
  netease: /^https?:\/\/www\.163\.com\/(?:news|dy)\/article\//i,
};

const PLATFORM_BODY_SELECTORS: Record<Platform, string[]> = {
  wechat: ["#js_content"],
  bbc: ['article div[data-component="text-block"]', "article"],
  cnn: ["main"],
  netease: ["div.post_body"],
};

const GENERIC_BODY_SELECTORS = [
  "article",
  'main[role="main"]',
  "main",
  '[itemprop="articleBody"]',
  ".article-body",
  ".article-content",
  ".post-content",
  ".entry-content",
  "[class*=" + '"article-body"' + "]",
  "[class*=" + '"article-content"' + "]",
];

const cleanText = (value: string): string => value.replace(/\s+/g, " ").trim();

function detectPlatform(url: string): Platform | null {
  for (const [platform, pattern] of Object.entries(PLATFORM_PATTERNS) as Array<[Platform, RegExp]>) {
    if (pattern.test(url)) return platform;
  }
  return null;
}

function canonicalUrl(value: string, baseUrl: string): string {
  try {
    const url = new URL(value, baseUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return value.trim();
  }
}

function articleId(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return decodeURIComponent(parts.at(-1) || parsed.hostname);
  } catch {
    return url;
  }
}

function firstText($: ReturnType<typeof load>, selectors: string[]): string {
  for (const selector of selectors) {
    const value = cleanText($(selector).first().text());
    if (value) return value;
  }
  return "";
}

function firstAttribute($: ReturnType<typeof load>, selectors: string[], attribute: string): string {
  for (const selector of selectors) {
    const value = cleanText($(selector).first().attr(attribute) || "");
    if (value) return value;
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function jsonLdRecords($: ReturnType<typeof load>): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  $("script[type='application/ld+json']").each((_index, node: AnyNode) => {
    const raw = $(node).text().trim();
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      const values = Array.isArray(parsed) ? parsed : [parsed];
      values.forEach((value) => {
        const record = asRecord(value);
        if (record) records.push(record);
      });
    } catch {
      // Some publishers emit invalid JSON-LD; other extraction paths remain usable.
    }
  });
  return records;
}

function firstJsonLdValue(records: Array<Record<string, unknown>>, keys: string[]): string {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && cleanText(value)) return cleanText(value);
    }
  }
  return "";
}

function normalizeDate(value: string): string {
  const text = cleanText(value);
  if (!text) return "";
  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? text : new Date(timestamp).toISOString();
}

function pushUnique(contents: ContentItem[], item: ContentItem): void {
  if (!item.content || contents.some((current) => current.type === item.type && current.content === item.content)) return;
  contents.push(item);
}

function extractContents($: ReturnType<typeof load>, selector: string, baseUrl: string): ContentItem[] {
  const root = $(selector).first();
  if (!root.length) return [];
  const contents: ContentItem[] = [];
  root.find("p,h2,h3,li,blockquote,img,video,iframe").toArray().forEach((node: AnyNode) => {
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    const current = $(node);
    if (tag === "img") {
      const source = current.attr("src") || current.attr("data-src") || current.attr("data-original");
      if (source) pushUnique(contents, { type: "image", content: canonicalUrl(source, baseUrl), desc: cleanText(current.attr("alt") || source) });
      return;
    }
    if (tag === "video" || tag === "iframe") {
      const source = current.attr("src") || current.find("source").first().attr("src");
      if (source) pushUnique(contents, { type: "video", content: canonicalUrl(source, baseUrl), desc: source });
      return;
    }
    if (tag === "li" && current.find("p").length > 0) return;
    const text = cleanText(current.text());
    if (!text) return;
    const formatted = tag === "h2" || tag === "h3" ? `## ${text}` : tag === "li" ? `• ${text}` : text;
    pushUnique(contents, { type: "text", content: formatted, desc: text });
  });
  if (!contents.length) {
    const text = cleanText(root.text());
    if (text) pushUnique(contents, { type: "text", content: text, desc: text });
  }
  return contents;
}

function scoreBody($: ReturnType<typeof load>, selector: string): { score: number; textLength: number } {
  const node = $(selector).first();
  if (!node.length) return { score: 0, textLength: 0 };
  const textLength = cleanText(node.text()).length;
  const paragraphs = node.find("p").length;
  const links = cleanText(node.find("a").text()).length;
  return { score: textLength + paragraphs * 180 - Math.min(links, textLength) * 0.35, textLength };
}

function selectGenericBody($: ReturnType<typeof load>): string | null {
  let winner: { selector: string; score: number; textLength: number } | null = null;
  for (const selector of GENERIC_BODY_SELECTORS) {
    const candidate = scoreBody($, selector);
    if (candidate.textLength < 120) continue;
    if (!winner || candidate.score > winner.score) winner = { selector, ...candidate };
  }
  return winner?.selector || null;
}

function buildItem(url: string, title: string, publishTime: string, authorName: string, authorUrl: string, contents: ContentItem[], extra: Record<string, unknown> = {}): NewsItem {
  const texts = contents.filter((item) => item.type === "text").map((item) => item.content);
  const images = contents.filter((item) => item.type === "image").map((item) => item.content);
  const videos = contents.filter((item) => item.type === "video").map((item) => item.content);
  return {
    title: cleanText(title),
    news_url: url,
    news_id: articleId(url),
    meta_info: { author_name: cleanText(authorName), author_url: authorUrl, publish_time: normalizeDate(publishTime) },
    contents,
    texts,
    images,
    videos,
    extra,
  };
}

function parseHtml(url: string, html: string, platform: Platform | null): ExtractionResult {
  const $ = load(html);
  $("script,style,noscript,template").remove();
  const records = jsonLdRecords(load(html));
  const title = firstJsonLdValue(records, ["headline", "name"]) || firstAttribute($, ["meta[property='og:title']", "meta[name='twitter:title']"], "content") || firstText($, platform === "wechat" ? ["#activity-name", "h1", "title"] : ["h1", "title"]);
  const publishTime = firstJsonLdValue(records, ["datePublished", "dateCreated"]) || firstAttribute($, ["meta[property='article:published_time']", "meta[name='datePublished']", "time[datetime]"], "content") || firstAttribute($, ["time[datetime]"], "datetime") || firstText($, ["time"]);
  const authorName = firstJsonLdValue(records, ["author"]) || firstAttribute($, ["meta[name='author']"], "content") || firstText($, ["[rel='author']", "[data-component='byline-block']", ".byline"]);
  const authorUrl = firstAttribute($, ["[rel='author'] a", "[data-component='byline-block'] a"], "href");
  const bodySelector = platform ? PLATFORM_BODY_SELECTORS[platform].find((selector) => scoreBody($, selector).textLength >= 120) : null;
  const genericSelector = bodySelector || selectGenericBody($);
  const contents = genericSelector ? extractContents($, genericSelector, url) : [];
  if (!title || !contents.some((item) => item.type === "text" && item.content.length >= 80)) {
    throw new NewsExtractionError("structured article content was not found", "parse_failed");
  }
  const method: ExtractionMethod = bodySelector ? "platform-rule" : "generic-rule";
  const confidence = bodySelector ? 0.95 : 0.65;
  return { item: buildItem(url, title, publishTime, authorName, authorUrl ? canonicalUrl(authorUrl, url) : "", contents, { extraction_method: method, platform, confidence }), platform, method, confidence, warnings: publishTime ? [] : ["publish_time_not_found"] };
}

function snippetFallback(url: string, snippet: NewsSnippet, warning: string): ExtractionResult {
  const title = cleanText(snippet.title || "");
  const summary = cleanText(snippet.summary || "");
  if (!title && !summary) throw new NewsExtractionError(warning, "parse_failed");
  const contents = summary ? [{ type: "text" as const, content: summary, desc: summary }] : [];
  const item = buildItem(url, title || url, snippet.publishedAt || "", "", "", contents, { extraction_method: "snippet-fallback", source_name: snippet.sourceName || "" });
  return { item, platform: detectPlatform(url), method: "snippet-fallback", confidence: 0.2, warnings: [warning] };
}

async function fetchHtml(url: string, timeoutMs: number, retries: number): Promise<string> {
  let lastError = "request failed";
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchExternalUrl(url, { timeoutMs, headers: { accept: "text/html,application/xhtml+xml" } });
      if (!response.ok) {
        await response.body?.cancel();
        lastError = `HTTP ${response.status}`;
      } else {
        return await response.text();
      }
    } catch (error) {
      lastError = formatRequestError(error);
    }
    if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw new NewsExtractionError(lastError, "fetch_failed");
}

export async function extractNews(url: string, options: ExtractNewsOptions = {}): Promise<ExtractionResult> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new NewsExtractionError("invalid article URL", "invalid_url");
  }
  if (!/^https?:$/.test(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new NewsExtractionError("only credential-free HTTP(S) URLs are supported", "invalid_url");
  }
  const canonical = parsedUrl.toString();
  const platform = (options.platform && options.platform in PLATFORM_PATTERNS ? options.platform as Platform : detectPlatform(canonical));
  try {
    const html = options.html ?? await fetchHtml(canonical, options.timeoutMs ?? 12_000, options.retries ?? 1);
    return parseHtml(canonical, html, platform);
  } catch (error) {
    if (options.snippet) return snippetFallback(canonical, options.snippet, formatRequestError(error));
    if (error instanceof NewsExtractionError) throw error;
    throw new NewsExtractionError(formatRequestError(error), "parse_failed");
  }
}
