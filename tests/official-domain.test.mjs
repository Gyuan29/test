import assert from "node:assert/strict";
import test from "node:test";

import { normalizeOfficialDomain } from "../lib/official-domain.js";

test("accepts institution domains and rejects generic platform domains", () => {
  assert.equal(normalizeOfficialDomain("https://www.example.edu/research"), "example.edu");
  assert.equal(normalizeOfficialDomain("play.google.com"), null);
  assert.equal(normalizeOfficialDomain("jingyan.baidu.com"), null);
});
