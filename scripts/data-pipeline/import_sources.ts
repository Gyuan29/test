import { mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { organizations } from "../../db/schema";
import { normalizeOfficialDomain } from "../../lib/official-domain.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const inputPath = resolve(projectRoot, "data", "organization_sources_secure.json");
const databasePath = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(projectRoot, ".local", "d1.sqlite");
const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 60;
const SKIPPED_SAMPLE_LIMIT = 10;

type SourceRecord = {
  name?: unknown;
  status?: unknown;
  official_domain?: unknown;
  domain?: unknown;
  [key: string]: unknown;
};

type SourceFile = { organizations?: unknown };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function slugForName(name: string): string {
  const readable = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  if (readable) return readable;
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 16);
  return `source-${digest}`;
}

function entityIdForSlug(slug: string): string {
  return `org-${slug}`;
}

function readSourceRecords(): SourceRecord[] {
  const parsed = JSON.parse(readFileSync(inputPath, "utf8")) as SourceFile;
  if (!Array.isArray(parsed.organizations)) {
    throw new Error(`Invalid source file: organizations must be an array (${inputPath})`);
  }
  return parsed.organizations.filter((record): record is SourceRecord => Boolean(record && typeof record === "object"));
}

function skipReasonFor(record: SourceRecord, name: string | null, domain: string | null, rawDomain: string | null): string | null {
  if (!name) return "缺少 name 字段";
  if (name.length < MIN_NAME_LENGTH) return `名称过短 (<${MIN_NAME_LENGTH}字符)`;
  if (name.length > MAX_NAME_LENGTH) return `名称过长 (>${MAX_NAME_LENGTH}字符)，疑似描述性短语`;
  const status = isNonEmptyString(record.status) ? record.status.trim().toLowerCase() : null;
  if (status === "failed") return "status 为 failed";
  if (!rawDomain) return "缺少 official_domain 或 domain 字段";
  if (!domain) return `域名格式无效: ${JSON.stringify(rawDomain)}`;
  return null;
}

function printSkipSummary(skipReasons: Map<string, number>, skippedSamples: Array<{ reason: string; record: SourceRecord }>): void {
  console.log("\n[跳过统计]");
  if (skipReasons.size === 0) console.log("无跳过记录。");
  for (const [reason, count] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    console.log(`- ${reason}: ${count}`);
  }
  console.log(`\n[跳过样本] 前 ${Math.min(SKIPPED_SAMPLE_LIMIT, skippedSamples.length)} 个被跳过的完整记录`);
  if (skippedSamples.length === 0) {
    console.log("无跳过记录。");
    return;
  }
  for (const [index, sample] of skippedSamples.entries()) {
    console.log(`[跳过样本 ${index + 1}] 原因: ${sample.reason}`);
    console.log(JSON.stringify(sample.record, null, 2));
  }
}

async function main(): Promise<void> {
  const records = readSourceRecords();
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const client = createClient({ url: databasePath === ":memory:" ? "file::memory:" : `file:${databasePath}` });
  const db = drizzle(client);
  let imported = 0;
  let skipped = 0;
  const skipReasons = new Map<string, number>();
  const skippedSamples: Array<{ reason: string; record: SourceRecord }> = [];

  try {
    await db.transaction(async (tx) => {
      for (const record of records) {
        const name = isNonEmptyString(record.name) ? record.name.trim() : null;
        const rawDomain = isNonEmptyString(record.official_domain)
          ? record.official_domain
          : isNonEmptyString(record.domain)
            ? record.domain
            : null;
        const domain = normalizeOfficialDomain(rawDomain);
        const skipReason = skipReasonFor(record, name, domain, rawDomain);
        if (skipReason) {
          skipped += 1;
          skipReasons.set(skipReason, (skipReasons.get(skipReason) ?? 0) + 1);
          if (skippedSamples.length < SKIPPED_SAMPLE_LIMIT) skippedSamples.push({ reason: skipReason, record });
          console.log(`[跳过] 机构: ${JSON.stringify(name ?? "<缺少名称>")} -> 原因: ${skipReason}`);
          continue;
        }
        if (!name || !domain) throw new Error("内部错误：通过校验的记录缺少名称或域名");

        const existing = await tx.select({ entityId: organizations.entityId, slug: organizations.slug }).from(organizations).where(eq(organizations.name, name)).limit(1).get();
        let slug = existing?.slug ?? slugForName(name);
        if (!existing) {
          const slugOwner = await tx.select({ entityId: organizations.entityId, name: organizations.name }).from(organizations).where(eq(organizations.slug, slug)).limit(1).get();
          if (slugOwner && slugOwner.name !== name) slug = `${slug}-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
        }

        console.log(`[导入] 正在处理: ${name} (domain: ${domain})`);
        await tx.insert(organizations).values({
          entityId: existing?.entityId ?? entityIdForSlug(slug), slug, name, entityType: "organization", region: "unknown", country: "unknown",
          credibilityScore: 80, source: "auto_discovered", sourceCount: 1, websiteUrl: `https://${domain}`, originalName: name,
        }).onConflictDoUpdate({
          target: organizations.slug,
          set: { websiteUrl: `https://${domain}`, credibilityScore: 80, source: "auto_discovered", updatedAt: new Date().toISOString() },
        }).run();
        imported += 1;
      }
    });
  } finally {
    client.close();
  }
  console.log(`\n[完成] 成功导入/更新 ${imported} 个机构，跳过 ${skipped} 个记录。`);
  printSkipSummary(skipReasons, skippedSamples);
}

try {
  await main();
} catch (error) {
  console.error("[导入] 失败:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
