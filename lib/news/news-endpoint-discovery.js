import { load } from "cheerio";
import { officialSiteKey } from "./official-site-key.js";

export async function discoverOfficialNewsEndpoints({ homepageUrl, html = "", pathHints = [], preferredSourceTypes = ["rss", "json", "api", "sitemap", "html"] }) {
  const homepage = new URL(homepageUrl);
  const siteKey = officialSiteKey(homepage.hostname);
  const $ = load(html);
  const candidates = [];
  const add = (url, sourceType) => {
    try {
      const parsed = new URL(url, homepage);
      if (officialSiteKey(parsed.hostname) !== siteKey) return;
      const normalized = parsed.toString();
      if (!candidates.some((item) => item.url === normalized)) candidates.push({ url: normalized, sourceType });
    } catch {}
  };
  $("link[rel='alternate'], link[rel='sitemap']").each((_, element) => {
    const rel = String($(element).attr("rel") ?? "").toLowerCase();
    const type = String($(element).attr("type") ?? "").toLowerCase();
    const href = $(element).attr("href");
    if (!href) return;
    if (rel.includes("sitemap")) add(href, "sitemap");
    else if (type.includes("rss") || type.includes("atom") || href.endsWith(".xml")) add(href, "rss");
    else if (type.includes("json")) add(href, "json");
  });
  if ($('meta[name="generator"][content*="WordPress" i]').length) add("/wp-json/wp/v2/posts?per_page=10", "api");
  for (const hint of pathHints) add(`${String(hint).replace(/^\//, "")}/`, "html");
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const text = $(element).text();
    if (href && /news|press|event|公告|新闻|动态/i.test(`${href} ${text}`)) add(href, "html");
  });
  add("/sitemap.xml", "sitemap");
  const rank = new Map(preferredSourceTypes.map((type, index) => [type, index]));
  candidates.sort((left, right) => (rank.get(left.sourceType) ?? 99) - (rank.get(right.sourceType) ?? 99));
  return candidates;
}
