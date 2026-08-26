import assert from "node:assert/strict";
import test from "node:test";

test("classifies transient and terminal official-source failures", async () => {
  const { classifySourceHealth } = await import("../lib/news/source-health.js");
  assert.equal(classifySourceHealth({ status: 429 }).retryClass, "backoff");
  assert.equal(classifySourceHealth({ status: 404 }).retryClass, "reprobe");
  assert.equal(classifySourceHealth({ errorCode: "ETIMEDOUT" }).retryClass, "retry");
});
