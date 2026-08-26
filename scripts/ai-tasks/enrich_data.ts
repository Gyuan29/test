/**
 * Fetch official organization websites and store cleaned source text on
 * sparse organization records.
 *
 * The current schema calls the imported official_domain value website_url.
 * This script reads organizations.website_url as the official domain.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { eq, isNull, or, sql } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { organizations } from "../../db/schema";
import { chatCompletion } from "../../lib/llm-client";
import { fetchExternalUrl } from "../../lib/security-url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const databasePath = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(projectRoot, ".local", "d1.sqlite");
const progressPath = resolve(projectRoot, "data", "enrich_progress.json");
const MAX_TEXT_LENGTH = 600;
const RAW_TEXT_PREFIX = "[自动抓取] ";
const REQUEST_TIMEOUT_MS = 5000;
const REQUEST_DELAY_MS = 1500;
const DESCRIPTION_SYSTEM_PROMPT = "Write a concise, factual Chinese organization introduction from the supplied official website text. Output only the introduction, with no headings or caveats.";

type Progress = {
  successfulIds: string[];
  updatedAt: string;
};

type HtmlLoader = (html: string) => {
  (selector: string): { remove(): void; text(): string };
};

type Candidate = {
  entityId: string;
  name: string;
  description: string | null;
  officialDomain: string | null;
};

let loadHtml: HtmlLoader | undefined;

async function getHtmlLoader(): Promise<HtmlLoader> {
  if (loadHtml) return loadHtml;
  try {
    const cheerio = await import("cheerio");
    loadHtml = cheerio.load as unknown as HtmlLoader;
    return loadHtml;
  } catch {
    throw new Error("Missing dependency: cheerio. Run npm install cheerio first.");
  }
}

function parseArgs(): { limit?: number; resume: boolean } {
  const args = process.argv.slice(2);
  const limitIndex = args.indexOf("--limit");
  let limit: number | undefined;
  if (limitIndex >= 0) {
    const value = Number(args[limitIndex + 1]);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error("--limit must be a positive integer");
    }
    limit = value;
  }
  return { limit, resume: args.includes("--resume") };
}

function readProgress(resume: boolean): Progress {
  if (!resume) return { successfulIds: [], updatedAt: new Date().toISOString() };
  try {
    const parsed = JSON.parse(readFileSync(progressPath, "utf8")) as Partial<Progress>;
    return {
      successfulIds: Array.isArray(parsed.successfulIds)
        ? parsed.successfulIds.filter((value): value is string => typeof value === "string")
        : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return { successfulIds: [], updatedAt: new Date().toISOString() };
  }
}

function saveProgress(progress: Progress): void {
  progress.updatedAt = new Date().toISOString();
  mkdirSync(dirname(progressPath), { recursive: true });
  writeFileSync(progressPath, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
}

function normalizeDomain(value: string | null): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
    return url.hostname ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function candidateUrls(domain: string): string[] {
  const origin = `https://${domain}`;
  return [`${origin}/`, `${origin}/about`, `${origin}/about-us`];
}

async function fetchPage(url: string): Promise<string> {
  const response = await fetchExternalUrl(url, {
    timeoutMs: REQUEST_TIMEOUT_MS,
    headers: { "user-agent": "institution-intelligence-enricher/1.0" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  const $ = (await getHtmlLoader())(html);
  $("script, style, nav, footer, header, noscript, svg, form").remove();
  return $("body").text().replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);
}

async function scrapeOrganization(domain: string): Promise<string> {
  let firstError: unknown;
  for (const url of candidateUrls(domain)) {
    try {
      const text = await fetchPage(url);
      if (text.length >= 80 || url.endsWith("about-us")) return text;
    } catch (error) {
      firstError = error;
    }
  }
  throw new Error(firstError instanceof Error ? firstError.message : "Page text was too short or unavailable");
}

async function generateDescription(name: string, sourceText: string): Promise<string> {
  return chatCompletion(DESCRIPTION_SYSTEM_PROMPT, `Organization: ${name}\nOfficial website text:\n${sourceText}`, { timeout: 120_000 });
}

async function main(): Promise<void> {
  const { limit, resume } = parseArgs();
  const progress = readProgress(resume);
  const completed = new Set(progress.successfulIds);
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const client = createClient({ url: databasePath === ":memory:" ? "file::memory:" : `file:${databasePath}` });
  const db = drizzle(client);
  let success = 0;
  let failed = 0;
  let skipped = 0;

  try {
    const sparse = await db.select({
      entityId: organizations.entityId,
      name: organizations.name,
      description: organizations.description,
      // official_domain is imported into website_url by import_verified_sources.ts.
      officialDomain: organizations.websiteUrl,
    }).from(organizations)
      .where(or(isNull(organizations.description), sql`length(trim(${organizations.description})) < 5`))
      .all() as unknown as Candidate[];
    const pending = sparse.filter((organization) => {
      if (completed.has(organization.entityId)) {
        skipped += 1;
        return false;
      }
      return true;
    }).slice(0, limit);
    const total = pending.length;

    for (const [index, organization] of pending.entries()) {
      const position = index + 1;
      const domain = normalizeDomain(organization.officialDomain);
      if (!domain) {
        skipped += 1;
        console.log(`[${position}/${total}] 跳过: ${organization.name} -> 缺少 official_domain`);
        saveProgress(progress);
        continue;
      }
      try {
        const text = await scrapeOrganization(domain);
        if (text.length < 20) throw new Error("网页有效文本不足");
        let description: string;
        try {
          description = await generateDescription(organization.name, text);
        } catch (error) {
          console.warn(`LLM description generation failed for ${organization.name}; preserving scraped text: ${error instanceof Error ? error.message : String(error)}`);
          description = `${RAW_TEXT_PREFIX}${text}`;
        }
        await db.update(organizations)
          .set({ description, updatedAt: new Date().toISOString() })
          .where(eq(organizations.entityId, organization.entityId))
          .run();
        completed.add(organization.entityId);
        progress.successfulIds = [...completed];
        saveProgress(progress);
        success += 1;
        console.log(`[${position}/${total}] 处理: ${organization.name} -> 抓取成功 (提取 ${text.length} 字符) -> 已直接存入 description`);
      } catch (error) {
        failed += 1;
        console.error(`[${position}/${total}] 失败: ${organization.name} -> ${error instanceof Error ? error.message : String(error)}`);
        saveProgress(progress);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, REQUEST_DELAY_MS));
    }
  } finally {
    client.close();
  }
  console.log(`\n完成：成功 ${success}，失败 ${failed}，跳过 ${skipped}`);
}

main().catch((error) => {
  console.error("数据丰富脚本失败:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
