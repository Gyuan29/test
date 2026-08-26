import assert from "node:assert/strict";
import test from "node:test";

test("strict candidate validation rejects unrelated mainstream domains", async () => {
  const { isStrictCandidate } = await import("../lib/source-quality");
  const organization = { name: "Bar-Ilan University", aliases: ["BIU"] };
  assert.equal(isStrictCandidate({ url: "https://1010poolbar.com/", title: "Pool bar", content: "Cocktail bar" }, organization), false);
  assert.equal(isStrictCandidate({ url: "https://biu.ac.il/", title: "Bar-Ilan University", content: "Bar-Ilan University official site" }, organization), true);
});

test("homepage verification requires organization evidence in page content", async () => {
  const { verifyCandidateHomepage } = await import("../lib/source-quality");
  const organization = { name: "Bar-Ilan University", aliases: ["BIU"] };
  const unrelated = await verifyCandidateHomepage("https://example.edu/", organization, { fetchImpl: async () => new Response("<html><title>Unrelated College</title><body>Welcome</body></html>", { status: 200, headers: { "content-type": "text/html" } }) });
  const official = await verifyCandidateHomepage("https://biu.ac.il/", organization, { fetchImpl: async () => new Response("<html><title>Bar-Ilan University</title><body>BIU official university</body></html>", { status: 200, headers: { "content-type": "text/html" } }) });
  assert.equal(unrelated, false);
  assert.equal(official, true);
});

test("SearXNG health check rejects an endpoint returning irrelevant results", async () => {
  const { checkSearxngHealth } = await import("../lib/searxng-health");
  const result = await checkSearxngHealth("https://search.example", { fetchImpl: async () => new Response(JSON.stringify({ results: [{ url: "https://dictionary.example/bar", title: "Bar definition", content: "A bar" }] }), { status: 200, headers: { "content-type": "application/json" } }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "irrelevant_results");
});

