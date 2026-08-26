import assert from "node:assert/strict";
import test from "node:test";

import { canStartAiSearch, resolveAiSearchModel } from "../lib/ai-search-config.js";

test("allows AI search for a saved OpenAI-compatible API configuration", () => {
  assert.equal(canStartAiSearch({ provider: "custom", apiKeyConfigured: true, busy: false }), true);
  assert.equal(canStartAiSearch({ provider: "openrouter", apiKeyConfigured: true, busy: false }), true);
});

test("blocks AI search without a saved key or while another discovery task is active", () => {
  assert.equal(canStartAiSearch({ provider: "custom", apiKeyConfigured: false, busy: false }), false);
  assert.equal(canStartAiSearch({ provider: "deepseek", apiKeyConfigured: true, busy: true }), false);
});

test("blocks providers that do not implement the OpenAI chat-completions API", () => {
  assert.equal(canStartAiSearch({ provider: "anthropic", apiKeyConfigured: true, busy: false }), false);
});

test("uses the account's preferred model for AI website discovery", () => {
  assert.equal(resolveAiSearchModel("gpt-5.4-mini"), "gpt-5.4-mini");
  assert.equal(resolveAiSearchModel(""), "gpt-4.1-mini");
});
