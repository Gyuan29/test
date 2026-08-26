import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, "..");
const scriptPath = join(projectRoot, "scripts", "discover_organization_sources.ts");
const tscPath = join(projectRoot, "node_modules", "typescript", "lib", "tsc.js");

test("SearXNG resumes from the secure checkpoint without re-querying completed records", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "organization-sources-resume-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const compiledDirectory = await mkdtemp(join(projectRoot, "tmp", "organization-sources-resume-"));
  t.after(() => rm(compiledDirectory, { recursive: true, force: true }));
  await execFileAsync(process.execPath, [tscPath, "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--skipLibCheck", "--outDir", compiledDirectory, scriptPath], { cwd: projectRoot });
  const compiledScriptPath = join(compiledDirectory, "discover_organization_sources.js");

  const inputPath = join(directory, "raw.json");
  const whitelistPath = join(directory, "whitelist.json");
  const outputPath = join(directory, "organization_sources_secure.json");
  await writeFile(inputPath, JSON.stringify([
    "Verified Institution",
    "Domain Institution",
    "Terminal Institution",
    "Retry Institution",
  ]));
  await writeFile(whitelistPath, JSON.stringify({ organizations: [] }));
  await writeFile(outputPath, JSON.stringify({
    schemaVersion: "organization-sources-secure/v1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    mode: "searxng",
    restoredNames: false,
    stats: {},
    organizations: [
      { name: "Verified Institution", status: "verified", checkedAt: "2026-01-01T00:00:00.000Z", official_domain: null, candidates: [], sources: [] },
      { name: "Domain Institution", status: "unverified", checkedAt: "2026-01-01T00:00:00.000Z", official_domain: "domain.example", candidates: [], sources: [] },
      { name: "Terminal Institution", status: "not_found", checkedAt: "2026-01-01T00:00:00.000Z", official_domain: null, candidates: [], sources: [] },
      { name: "Retry Institution", status: "unverified", checkedAt: "2026-01-01T00:00:00.000Z", official_domain: null, candidates: [], sources: [] },
    ],
  }));

  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url || "");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ results: [{ url: "https://retry.edu/" }] }));
  });
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  t.after(() => new Promise((resolveServer, rejectServer) => server.close((error) => error ? rejectServer(error) : resolveServer())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  await execFileAsync(process.execPath, [compiledScriptPath, "--searxng", "--input", inputPath, "--whitelist", whitelistPath, "--output", outputPath], {
    cwd: projectRoot,
    env: { ...process.env, SEARXNG_URL: `http://127.0.0.1:${address.port}` },
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0], /Retry%20Institution/);

  const persisted = JSON.parse(await readFile(outputPath, "utf8"));
  const byName = new Map(persisted.organizations.map((result) => [result.name, result]));
  assert.equal(byName.get("Verified Institution").status, "verified");
  assert.equal(byName.get("Domain Institution").official_domain, "domain.example");
  assert.equal(byName.get("Terminal Institution").status, "not_found");
  assert.equal(byName.get("Retry Institution").official_domain, "retry.edu");
});
