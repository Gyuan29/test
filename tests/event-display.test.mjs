import assert from "node:assert/strict";
import test from "node:test";

import { normalizeEventDate, normalizeEventDescription, normalizeEventTitle } from "../lib/event-display.js";

test("normalizes translated JSON fields and rejects invalid event dates", () => {
  assert.equal(normalizeEventTitle('{"title":"中文标题","description":"正文"}', "原始标题"), "中文标题");
  assert.equal(normalizeEventTitle('{"title":"中文标题","description":"正文"}\n附加说明', "原始标题"), "中文标题");
  assert.equal(normalizeEventTitle('{"title":"中文标题","description":"正文")\n附加说明', "原始标题"), "中文标题");
  assert.equal(normalizeEventDescription('{"title":"中文标题","description":"正文"}', "原始摘要"), "正文");
  assert.equal(normalizeEventDate("0099-12-31"), null);
  assert.equal(normalizeEventDate("unknown"), null);
  assert.equal(normalizeEventDate("2026-08-20"), "2026-08-20");
});
