import assert from "node:assert/strict";
import test from "node:test";

test("password hash verifier accepts the configured PBKDF2 format", async () => {
  const { hashPassword, verifyPasswordHash } = await import("../lib/auth");
  const encoded = await hashPassword("correct horse battery staple", 120_000);
  assert.match(encoded, /^pbkdf2\$sha256\$120000\$[^$]+\$[^$]+$/);
  assert.equal(await verifyPasswordHash("correct horse battery staple", encoded), true);
  assert.equal(await verifyPasswordHash("wrong", encoded), false);
});

test("session cookie signatures reject tampering", async () => {
  const { signSessionCookie, verifySessionCookie } = await import("../lib/auth");
  const cookie = await signSessionCookie("session-token", "test-secret");
  assert.equal(await verifySessionCookie(cookie, "test-secret"), "session-token");
  assert.equal(await verifySessionCookie(`${cookie}x`, "test-secret"), null);
});

test("rate limiter blocks the sixth request in a short window", async () => {
  const { createRateLimiter } = await import("../lib/request-limits");
  const limiter = createRateLimiter(5, 60_000);
  assert.equal(limiter.allow("user-1"), true);
  for (let index = 0; index < 4; index += 1) assert.equal(limiter.allow("user-1"), true);
  assert.equal(limiter.allow("user-1"), false);
  assert.equal(limiter.allow("user-2"), true);
});
