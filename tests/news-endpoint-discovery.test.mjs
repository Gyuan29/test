import assert from "node:assert/strict";
import test from "node:test";

test("prefers a same-domain RSS feed over a generic news index", async () => {
  const { discoverOfficialNewsEndpoints } = await import("../lib/news/news-endpoint-discovery.js");
  const result = await discoverOfficialNewsEndpoints({
    homepageUrl: "https://example.edu/",
    html: '<link rel="alternate" type="application/rss+xml" href="/news/feed.xml"><a href="/news">News</a>',
  });
  assert.equal(result[0].url, "https://example.edu/news/feed.xml");
  assert.equal(result[0].sourceType, "rss");
});

test("adds configured same-domain news path hints after feed candidates", async () => {
  const { discoverOfficialNewsEndpoints } = await import("../lib/news/news-endpoint-discovery.js");
  const result = await discoverOfficialNewsEndpoints({
    homepageUrl: "https://example.edu/",
    html: '<link rel="alternate" type="application/rss+xml" href="/feed.xml">',
    pathHints: ["newsroom"],
  });
  assert.equal(result[0].url, "https://example.edu/feed.xml");
  assert.equal(result.some((item) => item.url === "https://example.edu/newsroom/"), true);
});

test("discovers the WordPress posts API only from a WordPress homepage", async () => {
  const { discoverOfficialNewsEndpoints } = await import("../lib/news/news-endpoint-discovery.js");
  const result = await discoverOfficialNewsEndpoints({
    homepageUrl: "https://example.edu/",
    html: '<meta name="generator" content="WordPress 6.0">',
  });
  assert.equal(
    result.find((item) => item.sourceType === "api")?.url,
    "https://example.edu/wp-json/wp/v2/posts?per_page=10",
  );
});

test("discovers a same-domain sitemap declaration", async () => {
  const { discoverOfficialNewsEndpoints } = await import("../lib/news/news-endpoint-discovery.js");
  const result = await discoverOfficialNewsEndpoints({
    homepageUrl: "https://example.edu/",
    html: '<link rel="sitemap" type="application/xml" href="/sitemap.xml">',
  });
  assert.equal(result[0].url, "https://example.edu/sitemap.xml");
  assert.equal(result[0].sourceType, "sitemap");
});

test("adds the standard same-domain sitemap probe", async () => {
  const { discoverOfficialNewsEndpoints } = await import("../lib/news/news-endpoint-discovery.js");
  const result = await discoverOfficialNewsEndpoints({ homepageUrl: "https://example.edu/", html: "" });
  assert.equal(result[0].url, "https://example.edu/sitemap.xml");
  assert.equal(result[0].sourceType, "sitemap");
});

test("rejects an alternate feed hosted on another domain", async () => {
  const { discoverOfficialNewsEndpoints } = await import("../lib/news/news-endpoint-discovery.js");
  const result = await discoverOfficialNewsEndpoints({
    homepageUrl: "https://example.edu/",
    html: '<link rel="alternate" type="application/rss+xml" href="https://other.example/feed.xml">',
  });
  assert.equal(result.some((item) => item.url.includes("other.example")), false);
});

test("uses the route source order when choosing between verified endpoint types", async () => {
  const { discoverOfficialNewsEndpoints } = await import("../lib/news/news-endpoint-discovery.js");
  const result = await discoverOfficialNewsEndpoints({
    homepageUrl: "https://example.edu/",
    html: '<link rel="alternate" type="application/rss+xml" href="/feed.xml"><a href="/news">News</a>',
    preferredSourceTypes: ["html", "rss", "sitemap"],
  });
  assert.equal(result[0].sourceType, "html");
  assert.equal(result[0].url, "https://example.edu/news");
});
