import assert from "node:assert/strict";
import test from "node:test";

import { contentUpdates } from "../lib/content-cleanup.js";

test("builds idempotent updates for invalid organization and event content", () => {
  const updates = contentUpdates({
    website_url: "https://play.google.com",
    title: "Source title",
    summary: "原始摘要",
    translated_title: '{"title":"清理后的标题","description":"清理后的描述"}',
    translated_description: null,
    event_date: "0099-12-31",
  });

  assert.deepEqual(updates, {
    website_url: null,
    title: undefined,
    summary: undefined,
    translated_title: "清理后的标题",
    translated_description: undefined,
    event_date: "unknown",
  });
});
