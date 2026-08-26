import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [catalog, config, summary] = await Promise.all([
  readFile(new URL("../data/report-organizations.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../config/organization-quality.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../data/report-organization-summary.json", import.meta.url), "utf8").then(JSON.parse),
]);

function normalized(value) {
  return String(value || "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

test("organization form contains only allowed entity types and valid names", () => {
  const allowed = new Set(config.included_entity_types);
  const blocked = new Set(config.hard_reject_terms.map(normalized));
  for (const item of catalog) {
    assert.ok(allowed.has(item.entity_type), `${item.name}: disallowed type ${item.entity_type}`);
    assert.ok(!blocked.has(normalized(item.name)), `${item.name}: hard reject term`);
    for (const rule of config.invalid_name_patterns) {
      const chars = item.name.replace(/\s+/g, "").length;
      const words = item.name.match(/[A-Za-z0-9]+/g)?.length || 0;
      if (rule.min_chars && chars < rule.min_chars) continue;
      if (rule.min_words && words < rule.min_words) continue;
      assert.doesNotMatch(item.name, new RegExp(rule.pattern, rule.flags || ""));
    }
  }
});

test("every form organization has country and region", () => {
  for (const item of catalog) {
    assert.ok(item.country, `${item.name}: missing country`);
    assert.ok(item.region, `${item.name}: missing region`);
    assert.notEqual(item.location_confidence, "needs_review", `${item.name}: unresolved location`);
  }
  assert.equal(summary.location_complete_count, catalog.length);
  assert.equal(summary.location_needs_review_count, 0);
});

test("recovers a real institution from a phrase and excludes known fragments", () => {
  const names = new Set(catalog.map((item) => item.name));
  assert.ok(names.has("Incubateur HEC Paris"));
  assert.ok(!names.has("提供Incubateur HEC Paris"));
  assert.ok(!names.has("我们认为这是未来的方向"));
  assert.ok(!names.has("其软件已被沃尔沃汽车采用"));
});
