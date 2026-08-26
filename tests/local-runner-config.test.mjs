import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("local data runners load .env.local before reading service configuration", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  for (const scriptName of ["data:discover-sources", "ai:enrich", "ai:search-news"]) {
    assert.match(packageJson.scripts[scriptName], /--env-file-if-exists=\.env\.local/);
  }
});

test("local discovery runner targets the IPv4 listener configured by the launcher", async () => {
  const launcher = await readFile(new URL("../tools/run-cloudflare-dev.ps1", import.meta.url), "utf8");

  assert.match(launcher, /\$env:LOCAL_NEWS_APP_URL = "http:\/\/127\.0\.0\.1:\$Port"/);
});
