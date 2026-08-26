import assert from "node:assert/strict";
import test from "node:test";

import { extractAiSearchContent } from "../lib/ai-search-plan.js";

test("extracts a query plan returned as OpenAI content parts", () => {
  const plan = extractAiSearchContent([
    { type: "text", text: '{"queries":["Example Institute official website"]}' },
  ]);

  assert.equal(plan, '{"queries":["Example Institute official website"]}');
});

test("does not treat non-text content parts as a query plan", () => {
  assert.equal(extractAiSearchContent([{ type: "image_url", image_url: "https://example.com/image.png" }]), "");
});

test("rejects a query plan mixed with non-text content parts", () => {
  const plan = extractAiSearchContent([
    { type: "text", text: '{"queries":["Example Institute official website"]}' },
    { type: "image_url", image_url: "https://example.com/image.png" },
  ]);

  assert.equal(plan, "");
});
