import assert from "node:assert/strict";
import test from "node:test";

test("retries one transient official-source failure", async () => {
  const { fetchOfficialSource } = await import("../lib/news/collector.js");
  let calls = 0;
  const result = await fetchOfficialSource("https://example.org/news", {
    fetchImpl: async () => ++calls === 1 ? new Response("busy", { status: 503 }) : new Response("<title>News</title>"),
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 200);
});

test("cancels an unconsumed transient response before retrying", async () => {
  const { fetchOfficialSource } = await import("../lib/news/collector.js");
  let calls = 0;
  let cancelled = false;
  const transient = {
    status: 503,
    url: "https://example.org/news",
    headers: new Headers(),
    body: { cancel: async () => { cancelled = true; } },
  };

  await fetchOfficialSource("https://example.org/news", {
    fetchImpl: async () => ++calls === 1 ? transient : new Response("<title>News</title>"),
  });

  assert.equal(cancelled, true);
});
