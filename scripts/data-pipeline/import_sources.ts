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
const inputPath = resolve(projectRoot, "data", "raw_organizations.json");
const databasePath = process.env.LOCAL_SQLITE_PATH?.trim() || resolve(projectRoot, ".local", "d1.sqlite");
const SKIPPED_SAMPLE_LIMIT = 10;

type SourceRecord = { name?: unknown; status?: unknown; official_domain?: unknown; domain?: unknown; [key: string]: unknown };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function slugForName(name: string): string {
  const readable = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72);
  if (readable) return readable;
  return `source-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
}

function entityIdForSlug(slug: string): string { return `org-${slug}`; }

/** Read the complete raw array. Raw entries are normally names, but objects are accepted too. */
function readSourceRecords(): SourceRecord[] {
  const parsed = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Invalid source file: expected an array (${inputPath})`);
  return parsed.map((entry) => (typeof entry === "string" ? { name: entry } : entry as SourceRecord));
}

function printSkipSummary(skipReasons: Map<string, number>, skippedSamples: Array<{ reason: string; record: SourceRecord }>): void {
  console.log("\n[Skipped summary]");
  if (skipReasons.size === 0) console.log("No records skipped.");
  for (const [reason, count] of [...skipReasons.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) console.log(`- ${reason}: ${count}`);
  if (skippedSamples.length > 0) {
    console.log(`\n[Skipped samples] first ${skippedSamples.length}`);
    for (const [index, sample] of skippedSamples.entries()) console.log(`[${index + 1}] ${sample.reason}: ${JSON.stringify(sample.record)}`);
  }
}

async function main(): Promise<void> {
  const records = readSourceRecords();
  console.log(`[Import] Read ${records.length} records from ${inputPath}`);
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const client = createClient({ url: databasePath === ":memory:" ? "file::memory:" : `file:${databasePath}` });
  const db = drizzle(client);
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  const skipReasons = new Map<string, number>();
  const skippedSamples: Array<{ reason: string; record: SourceRecord }> = [];

  try {
    for (const [index, record] of records.entries()) {
      const name = isNonEmptyString(record?.name) ? record.name.trim() : null;
      if (!name) {
        skipped += 1;
        const reason = "missing name";
        skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
        if (skippedSamples.length < SKIPPED_SAMPLE_LIMIT) skippedSamples.push({ reason, record });
        if ((index + 1) % 50 === 0 || index + 1 === records.length) console.log(`[Progress] ${index + 1}/${records.length} processed, success=${succeeded}, failed=${failed}, skipped=${skipped}`);
        continue;
      }

      try {
        const rawDomain = isNonEmptyString(record.official_domain) ? record.official_domain.trim() : isNonEmptyString(record.domain) ? record.domain.trim() : null;
        const domain = normalizeOfficialDomain(rawDomain);
        const existing = await db.select({ entityId: organizations.entityId, slug: organizations.slug }).from(organizations).where(eq(organizations.name, name)).limit(1).get();
        let slug = existing?.slug ?? slugForName(name);
        if (!existing) {
          const slugOwner = await db.select({ entityId: organizations.entityId, name: organizations.name }).from(organizations).where(eq(organizations.slug, slug)).limit(1).get();
          if (slugOwner && slugOwner.name !== name) slug = `${slug}-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
        }

        const values = {
          entityId: existing?.entityId ?? entityIdForSlug(slug), slug, name, entityType: "organization", region: "unknown", country: "unknown",
          credibilityScore: 80, source: "raw_organizations", sourceCount: 1, originalName: name,
          ...(domain ? { websiteUrl: `https://${domain}` } : {}),
        };
        const updateSet = {
          name, originalName: name, credibilityScore: 80, source: "raw_organizations", sourceCount: 1,
          ...(domain ? { websiteUrl: `https://${domain}` } : {}), updatedAt: new Date().toISOString(),
        };
        await db.insert(organizations).values(values).onConflictDoUpdate({ target: organizations.slug, set: updateSet }).run();
        succeeded += 1;
      } catch (error) {
        failed += 1;
        console.error(`[Failed] record ${index + 1} (${name}):`, error instanceof Error ? error.message : error);
      }

      if ((index + 1) % 50 === 0 || index + 1 === records.length) console.log(`[Progress] ${index + 1}/${records.length} processed, success=${succeeded}, failed=${failed}, skipped=${skipped}`);
    }
  } finally {
    client.close();
  }

  console.log(`\n[Complete] success=${succeeded}, failed=${failed}, skipped=${skipped}, total=${records.length}`);
  printSkipSummary(skipReasons, skippedSamples);
}

try {
  await main();
} catch (error) {
  console.error("[Import] Fatal error:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
