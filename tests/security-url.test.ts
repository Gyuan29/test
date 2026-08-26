import assert from "node:assert/strict";
import test from "node:test";

test("safeFetchUrl rejects private and metadata destinations", async () => {
  const { validateExternalUrl } = await import("../lib/security-url");
  for (const value of [
    "http://127.0.0.1:8080/",
    "http://10.0.0.1/",
    "http://192.168.1.5/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "file:///etc/passwd",
  ]) {
    assert.equal(validateExternalUrl(value).ok, false, value);
  }
  assert.equal(validateExternalUrl("https://example.com/news").ok, true);
});

test("external redirects stay on the originally validated host", async () => {
  const { fetchExternalUrl } = await import("../lib/security-url");
  const calls: string[] = [];
  const response = await fetchExternalUrl("https://example.com/news", {
    fetchImpl: async (input, init) => {
      calls.push(String(input));
      assert.equal(init?.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
    },
  });
  assert.equal(response.status, 502);
  assert.deepEqual(calls, ["https://example.com/news"]);
});

