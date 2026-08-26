import assert from "node:assert/strict";
import test from "node:test";

const apiBaseUrl = process.env.TEST_NEWS_API_URL;

test("exposes retry and reprobe source counts", { skip: !apiBaseUrl && "set TEST_NEWS_API_URL to the Worker built from this worktree" }, async () => {
  const response = await fetch(`${apiBaseUrl}/api/news`);
  const data = await response.json();
  assert.equal(typeof data.sourceHealth.retryable, "number");
  assert.equal(typeof data.sourceHealth.reprobe, "number");
});
