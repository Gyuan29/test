import assert from "node:assert/strict";
import test from "node:test";

test("rejects off-domain RSS articles", async () => {
  const { extractRssArticles } = await import("../lib/news/parsers.js");
  const xml = '<item><title>A news release</title><link>https://example.org/news/a</link></item><item><title>B news release</title><link>https://other.example/b</link></item>';
  assert.deepEqual(
    extractRssArticles("https://example.org/feed.xml", xml).map((item) => item.url),
    ["https://example.org/news/a"],
  );
});

test("extracts same-domain JSON Feed items through the unified parser", async () => {
  const { extractOfficialArticles } = await import("../lib/news/parsers.js");
  const articles = extractOfficialArticles({
    url: "https://example.org/feed.json",
    sourceType: "json",
    contentType: "application/feed+json",
    text: JSON.stringify({ items: [{ title: "Programme update", url: "https://example.org/news/update" }] }),
  });
  assert.deepEqual(articles.map((item) => item.url), ["https://example.org/news/update"]);
});

test("extracts same-domain WordPress posts", async () => {
  const { extractOfficialArticles } = await import("../lib/news/parsers.js");
  const articles = extractOfficialArticles({
    url: "https://example.org/wp-json/wp/v2/posts?per_page=10",
    sourceType: "api",
    contentType: "application/json",
    text: JSON.stringify([{ link: "https://example.org/news/post", title: { rendered: "Research milestone" } }]),
  });
  assert.deepEqual(articles.map((item) => item.url), ["https://example.org/news/post"]);
});

test("extracts same-domain news URLs from a sitemap", async () => {
  const { extractOfficialArticles } = await import("../lib/news/parsers.js");
  const articles = extractOfficialArticles({
    url: "https://example.org/sitemap.xml",
    sourceType: "sitemap",
    contentType: "application/xml",
    text: '<urlset><url><loc>https://example.org/news/a</loc></url><url><loc>https://other.example/news/b</loc></url></urlset>',
  });
  assert.deepEqual(articles.map((item) => item.url), ["https://example.org/news/a"]);
});

test("extracts article links from an HTML news index", async () => {
  const { extractOfficialArticles } = await import("../lib/news/parsers.js");
  const articles = extractOfficialArticles({
    url: "https://example.org/news/",
    sourceType: "html",
    contentType: "text/html",
    text: '<a href="/news/launch">New programme launch</a><a href="https://other.example/news/b">Outside story</a>',
  });
  assert.deepEqual(articles.map((item) => item.url), ["https://example.org/news/launch"]);
});
