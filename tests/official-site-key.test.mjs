import assert from "node:assert/strict";
import test from "node:test";

test("normalizes www and compound public suffixes for official-domain checks", async () => {
  const { officialSiteKey } = await import("../lib/news/official-site-key.js");
  assert.equal(officialSiteKey("www.techstars.com"), "techstars.com");
  assert.equal(officialSiteKey("news.example.co.uk"), "example.co.uk");
});
