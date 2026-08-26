import assert from "node:assert/strict";
import test from "node:test";

test("parses a deduplicated SearXNG URL pool with legacy fallback", async () => {
  const { parseSearxngUrls } = await import("../lib/searxng-pool");
  assert.deepEqual(parseSearxngUrls({ SEARXNG_URLS: " https://one.example, https://two.example/ ,https://one.example ", SEARXNG_URL: "https://legacy.example" }), [
    "https://one.example",
    "https://two.example",
  ]);
  assert.deepEqual(parseSearxngUrls({ SEARXNG_URL: "https://legacy.example/" }), ["https://legacy.example"]);
  assert.deepEqual(parseSearxngUrls({ SEARXNG_URLS: "", SEARXNG_URL: "https://legacy.example/" }), ["https://legacy.example"]);
});

test("keeps healthy instances when one pool member fails", async () => {
  const { checkSearxngPool } = await import("../lib/searxng-pool");
  const result = await checkSearxngPool(["https://good.example", "https://bad.example"], {
    healthCheck: async (url) => url.includes("good") ? { ok: true } : { ok: false, reason: "irrelevant_results" },
  });
  assert.deepEqual(result.healthyUrls, ["https://good.example"]);
  assert.equal(result.failed.length, 1);
});

test("aggregates parallel results and deduplicates canonical URLs", async () => {
  const { aggregateSearxngResults } = await import("../lib/searxng-pool");
  const result = await aggregateSearxngResults(["https://one.example", "https://two.example"], "query", {
    query: async (baseUrl) => baseUrl.includes("one")
      ? [{ url: "https://biu.ac.il", title: "BIU" }]
      : [{ url: "https://biu.ac.il/", content: "Bar-Ilan University" }, { url: "https://other.example" }],
  });
  assert.deepEqual(result.map((item) => item.url), ["https://biu.ac.il", "https://other.example"]);
  assert.equal(result[0]?.title, "BIU");
  assert.equal(result[0]?.content, "Bar-Ilan University");
});
