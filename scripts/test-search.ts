#!/usr/bin/env npx tsx
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

const projectRoot = resolve(import.meta.dirname, "..");
for (const envFile of [resolve(projectRoot, ".env.local"), resolve(projectRoot, ".env")]) {
  if (existsSync(envFile)) {
    try { loadEnvFile(envFile); } catch { /* Shell environment remains usable. */ }
  }
}

const REQUEST_TIMEOUT_MS = 10_000;
const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error("Usage: npx tsx scripts/test-search.ts \"Institution name\"");
  process.exitCode = 2;
} else {
  type Hit = { title: string; url: string };

  async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as T;
  }

  async function searchSearxng(): Promise<Hit[]> {
    const baseUrl = (process.env.SEARXNG_URL || "http://localhost:8080").replace(/\/+$/, "");
    const body = await requestJson<{ results?: Array<{ title?: string; url?: string }> }>(
      `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=general`,
      { headers: { accept: "application/json" } },
    );
    return (body.results || []).flatMap((item) => item.url ? [{ title: item.title || "(untitled)", url: item.url }] : []).slice(0, 3);
  }

  async function searchBrave(): Promise<Hit[]> {
    const key = process.env.BRAVE_SEARCH_API_KEY?.trim();
    if (!key) throw new Error("BRAVE_SEARCH_API_KEY is not configured");
    const body = await requestJson<{ web?: { results?: Array<{ title?: string; url?: string }> } }>(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=3`,
      { headers: { accept: "application/json", "X-Subscription-Token": key } },
    );
    return (body.web?.results || []).flatMap((item) => item.url ? [{ title: item.title || "(untitled)", url: item.url }] : []).slice(0, 3);
  }

  async function searchBing(): Promise<Hit[]> {
    const key = process.env.BING_SEARCH_API_KEY?.trim();
    if (!key) throw new Error("BING_SEARCH_API_KEY is not configured");
    const body = await requestJson<{ webPages?: { value?: Array<{ name?: string; url?: string }> } }>(
      `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=3&responseFilter=Webpages`,
      { headers: { accept: "application/json", "Ocp-Apim-Subscription-Key": key } },
    );
    return (body.webPages?.value || []).flatMap((item) => item.url ? [{ title: item.name || "(untitled)", url: item.url }] : []).slice(0, 3);
  }

  async function runProvider(name: string, search: () => Promise<Hit[]>): Promise<void> {
    console.log(`\n=== ${name} ===`);
    try {
      const hits = await search();
      if (hits.length === 0) { console.log("No results"); return; }
      hits.forEach((hit, index) => console.log(`${index + 1}. ${hit.title}\n   ${hit.url}`));
    } catch (error) {
      console.log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await runProvider("SearXNG", searchSearxng);
  if (process.env.BRAVE_SEARCH_API_KEY?.trim()) await runProvider("Brave", searchBrave);
  else console.log("\n=== Brave ===\nSKIPPED: BRAVE_SEARCH_API_KEY is not configured");
  if (process.env.BING_SEARCH_API_KEY?.trim()) await runProvider("Bing", searchBing);
  else console.log("\n=== Bing ===\nSKIPPED: BING_SEARCH_API_KEY is not configured");
}
