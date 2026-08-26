import { load } from "cheerio";
import { officialSiteKey } from "./official-site-key.js";

function sameSite(baseUrl, candidate) {
  try { return officialSiteKey(new URL(baseUrl).hostname) === officialSiteKey(new URL(candidate, baseUrl).hostname); } catch { return false; }
}

function article(url, title) { return { url, title: String(title ?? "").trim() || url }; }

export function extractRssArticles(feedUrl, text) {
  const $ = load(text, { xmlMode: true });
  const result = [];
  $("item, entry").each((_, element) => {
    const link = $(element).find("link").first().attr("href") || $(element).find("link").first().text();
    if (link && sameSite(feedUrl, link)) result.push(article(new URL(link, feedUrl).toString(), $(element).find("title").first().text()));
  });
  return result;
}

export function extractOfficialArticles({ url, sourceType, text }) {
  if (sourceType === "sitemap") {
    const $ = load(text, { xmlMode: true });
    return $("loc").toArray().flatMap((element) => {
      const link = $(element).text().trim();
      return link && sameSite(url, link) ? [article(link, link)] : [];
    });
  }
  if (sourceType === "rss" || /xml|rss|atom/i.test(url)) return extractRssArticles(url, text);
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (sourceType === "json" || sourceType === "api" || Array.isArray(parsed)) {
    const items = Array.isArray(parsed) ? parsed : parsed?.items ?? [];
    return items.flatMap((item) => {
      const link = item?.url ?? item?.link;
      const title = typeof item?.title === "object" ? item.title.rendered : item?.title;
      return link && sameSite(url, link) ? [article(new URL(link, url).toString(), title)] : [];
    });
  }
  const $ = load(text);
  return $("a[href]").toArray().flatMap((element) => {
    const href = $(element).attr("href");
    return href && sameSite(url, href) ? [article(new URL(href, url).toString(), $(element).text())] : [];
  });
}
