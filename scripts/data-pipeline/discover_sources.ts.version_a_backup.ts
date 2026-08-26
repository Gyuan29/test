#!/usr/bin/env npx tsx
/**
 * Secure organization source discovery.
 *
 * !!! SECURITY WARNING !!!
 * This script handles sensitive organization lists. Immediately after every
 * run, set restrictive operating-system permissions on the output, for example:
 *   chmod 600 data/organization_sources_secure.json
 * On Windows, restrict the output ACL to the intended account. Ensure that
 * data/*.json and *.docx are strictly excluded by .gitignore, never committed,
 * uploaded, or printed in diagnostic logs.
 *
 * Whitelist example (data/known_domains_whitelist.json):
 * {
 *   "version": 1,
 *   "organizations": [
 *     { "code": "ORG_001", "domains": [
 *       { "url": "https://example.edu", "type": "official" }
 *     ] },
 *     { "name": "Public Organization", "domains": [
 *       { "url": "https://example.org" }
 *     ] }
 *   ]
 * }
 *
 * Desensitization example (data/desensitization_map.json):
 * {
 *   "version": 1,
 *   "mapping": { "真实机构名称": "ORG_001" },
 *   "pinyin": { "ORG_001": "zhen shi ji gou" }
 * }
 *
 * Typical commands (PowerShell):
 *   npx tsx scripts/data-pipeline/discover_sources.ts --offline
 *   npx tsx scripts/data-pipeline/discover_sources.ts --offline --restore --limit 5
 *   npx tsx scripts/data-pipeline/discover_sources.ts --searxng --limit 10
 *   npx tsx scripts/data-pipeline/discover_sources.ts --deep-search
 *   npx tsx scripts/data-pipeline/discover_sources.ts --searxng --dry-run --limit 10
 *   npx tsx scripts/data-pipeline/discover_sources.ts --dry-run --limit 5
 */

import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetch, type Response as UndiciResponse } from "undici";
import { createClient, type Client } from "@libsql/client";
import * as cheerio from "cheerio";
// If this import fails in a fresh checkout, install it with: npm install minimist
// @ts-expect-error minimist 1.x does not ship TypeScript declarations.
import minimist from "minimist";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_INPUT = resolve(PROJECT_ROOT, "data/raw_organizations.json");
const DEFAULT_WHITELIST = resolve(PROJECT_ROOT, "data/known_domains_whitelist.json");
const DEFAULT_MAP = resolve(PROJECT_ROOT, "data/desensitization_map.json");
const DEFAULT_OUTPUT = resolve(PROJECT_ROOT, "data/organization_sources_secure.json");
const DEFAULT_DATABASE_PATH = resolve(PROJECT_ROOT, ".local", "d1.sqlite");
const SEARCH_PROGRESS_PATH = resolve(PROJECT_ROOT, "data", "search_progress.json");

const REQUEST_TIMEOUT_MS = 10_000;
const BASE_DELAY_MS = 2_000;
const JITTER_MS = 2_000;
const MAX_CONCURRENCY = 2;
const MAX_CANDIDATES = 8;
const MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_SEARXNG_URL = "http://localhost:8080";
const DISALLOWED_DIRECT_DOMAINS = [
  "baidu.com",
  "baike.baidu.com",
  "wikipedia.org",
  "wikimedia.org",
  "zhihu.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "instagram.com",
  "youtube.com",
  "weibo.com",
  "douban.com",
  "reddit.com",
  "quora.com",
  "bilibili.com",
];
const MAX_REFERENCE_LINKS = 5;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/126.0.0.0 Chrome/126.0.0.0 Safari/537.36",
];

type Mode = "offline" | "online" | "searxng" | "deep-search";
type ResultStatus =
  | "verified"
  | "whitelist_match"
  | "whitelist_miss"
  | "online_verified"
  | "unverified"
  | "not_found"
  | "dns_failed"
  | "http_failed"
  | "error"
  | (string & {});

interface Config {
  input: string;
  whitelist: string;
  map: string;
  output: string;
  mode: Mode;
  restore: boolean;
  resume: boolean;
  dryRun: boolean;
  limit: number;
  startAt: number;
  showUnmatched: boolean;
  searxngUrl: string;
  deepSearch: boolean;
  skipHours: number;
  force: boolean;
  taskId: string;
}

interface Organization {
  originalName: string;
  identifier: string;
  pinyinHint?: string;
}

interface DesensitizationMap {
  realToCode: Map<string, string>;
  codeToReal: Map<string, string>;
  pinyinByCode: Map<string, string>;
}

interface Source {
  url: string;
  title?: string;
  type?: string;
  provider?: string;
  verified?: boolean;
}

interface SearchHit {
  url: string;
  title?: string;
  snippet?: string;
  provider: string;
}

interface SearchProvider {
  readonly name: string;
  search(query: string): Promise<SearchHit[]>;
}

type SearchStatus = "pending" | "success" | "failed";

let databaseClient: Client | undefined;

function getDatabaseClient(): Client {
  if (!databaseClient) {
    const databasePath = process.env.LOCAL_SQLITE_PATH?.trim() || DEFAULT_DATABASE_PATH;
    databaseClient = createClient({ url: databasePath === ":memory:" ? "file::memory:" : `file:${databasePath}` });
  }
  return databaseClient;
}

function closeDatabaseClient(): void {
  databaseClient?.close();
  databaseClient = undefined;
}

interface WhitelistEntry {
  name?: string;
  code?: string;
  aliases: string[];
  sources: Source[];
}

interface HttpProbe {
  path: "/" | "/robots.txt";
  status: number;
  contentType?: string;
}

interface DomainProbe {
  domain: string;
  dns: "ok" | "failed";
  root?: HttpProbe;
  robots?: HttpProbe;
  error?: string;
}

interface OrganizationResult {
  name: string;
  status: ResultStatus;
  checkedAt: string;
  official_domain: string | null;
  candidates: string[];
  sources: Source[];
  probes?: DomainProbe[];
  matchedBy?: "name" | "code" | "alias";
  error?: string;
}

interface DnsAddress {
  address: string;
  family: number;
}

interface PersistedOutput {
  schemaVersion: "organization-sources-secure/v1";
  generatedAt: string;
  mode: Mode;
  restoredNames: boolean;
  stats: {
    inputOrganizations: number;
    processedOrganizations: number;
    whitelistMatches: number;
    whitelistMisses: number;
    onlineVerified: number;
    searxngVerified: number;
    heuristicMatches: number;
    unverified: number;
    notFound: number;
    dnsFailed: number;
    httpFailed: number;
    errors: number;
  };
  organizations: OrganizationResult[];
}

interface ResultStore {
  find(organization: Organization): OrganizationResult | undefined;
  upsert(organization: Organization, result: OrganizationResult): void;
  results(): OrganizationResult[];
}

const dnsCache = new Map<string, Promise<DnsAddress[]>>();
let nextSearchRequestAt = 0;

async function main(): Promise<void> {
  const config = parseArguments();
  const map = await readDesensitizationMap(config.map);
  const allOrganizations = await readOrganizations(config.input, map);
  const forceSearch = config.force || config.skipHours === 0;
  const eligibleKeys = config.dryRun || forceSearch ? undefined : await readEligibleOrganizationKeys(config.skipHours);
  const eligibleOrganizations = eligibleKeys
    ? allOrganizations.filter((organization) => organizationKeys(organization).some((key) => eligibleKeys.has(key)))
    : allOrganizations;
  const selected = config.limit === Infinity
    ? eligibleOrganizations.slice(config.startAt)
    : eligibleOrganizations.slice(config.startAt, config.startAt + config.limit);
  await writeSearchProgress({ taskId: config.taskId || `search_${process.pid}`, total: selected.length, processed: 0, success: 0, failed: 0, currentInstitution: null, status: "running", lastUpdated: new Date().toISOString() });

  if (selected.length === 0) {
    const message = "没有需要更新的机构（所有机构均已搜索或不在时间范围内）";
    await writeSearchProgress({ taskId: config.taskId || `search_${process.pid}`, total: 0, processed: 0, success: 0, failed: 0, currentInstitution: null, status: "completed", message, lastUpdated: new Date().toISOString() });
    log(`[完成] ${message}`);
    return;
  }

  log(`[开始] 模式=${config.mode} 输入机构=${allOrganizations.length} 本次处理=${selected.length}`);

  // Dry-run is deliberately network-free even when --offline is omitted.
  if (config.dryRun) {
    log(`[准备] 共需处理 ${selected.length} 个机构 (已跳过 0 个已验证的机构)`);
    runDryRun(config, selected);
    log(`[完成] 成功 ${selected.length} 个，失败 0 个，跳过 0 个`);
    return;
  }

  if (config.mode === "offline") {
    // This branch reads only local files. Do not add DNS, HTTP, or delay calls here.
    const whitelist = await readWhitelist(config.whitelist);
    log(`[准备] 共需处理 ${selected.length} 个机构 (已跳过 0 个已验证的机构)`);
    const results = selected.map((organization, index) => processOffline(organization, whitelist, index, selected.length, config.restore));
    for (const [index, organization] of selected.entries()) {
      log(`[机构] 正在处理机构 ${organization.originalName} (${index + 1}/${selected.length})`);
      const status = results[index].status === "whitelist_match" ? "success" : "failed";
      await updateSearchState(organization, status);
      await writeSearchProgress({ taskId: config.taskId || `search_${process.pid}`, total: selected.length, processed: index + 1, success: results.slice(0, index + 1).filter((item) => item.status === "whitelist_match").length, failed: index + 1 - results.slice(0, index + 1).filter((item) => item.status === "whitelist_match").length, currentInstitution: organization.originalName, status: index + 1 === selected.length ? "completed" : "running", lastUpdated: new Date().toISOString() });
    }
    await persist(config, allOrganizations.length, results);
    if (config.showUnmatched) printUnmatched(results);
    logCompletionStats(results, selected, 0);
    log(`[完成] 离线结果已写入 ${config.output}`);
    return;
  }

  if (config.mode === "searxng" || config.mode === "deep-search") {
    // SearXNG is only contacted from this explicit branch. Offline mode never
    // performs DNS, HTTP, or search requests.
    // Load the previous checkpoint before doing any matching so a resumed run
    // never queries an organization that has already been resolved.
    const previousResults = config.resume ? await readPersistedResults(config.output) : [];
    const resultStore = createResultStore(previousResults);
    const whitelist = await readWhitelist(config.whitelist);
    const unmatched: Organization[] = [];
    const runResults = new Map<string, OrganizationResult>();
    let resumedVerified = 0;
    const resumedOther = 0;

    const initialSkipped = selected.filter((organization) => {
      const previous = resultStore.find(organization);
      return Boolean(previous && isResumeSkipResult(previous));
    }).length;
    log(`[准备] 共需处理 ${selected.length - initialSkipped} 个机构 (已跳过 ${initialSkipped} 个已验证的机构)`);

    for (const [index, organization] of selected.entries()) {
      log(`[机构] 正在处理机构 ${organization.originalName} (${index + 1}/${selected.length})`);
      const previous = resultStore.find(organization);
      if (previous && isResumeSkipResult(previous)) {
        resumedVerified += 1;
        continue;
      }

      const offlineResult = processOffline(organization, whitelist, index, selected.length, config.restore);
      if (offlineResult.status === "whitelist_match") {
        resultStore.upsert(organization, offlineResult);
        runResults.set(resultKeyForMerge(offlineResult), offlineResult);
        await updateSearchState(organization, "success");
        await writeSearchProgress({ taskId: config.taskId || `search_${process.pid}`, total: selected.length, processed: index + 1, success: index + 1, failed: 0, currentInstitution: organization.originalName, status: "running", lastUpdated: new Date().toISOString() });
        continue;
      }

      unmatched.push(organization);
    }

    // Persist offline matches before issuing the first search request. This is
    // also the initial checkpoint for a full run resumed from a partial file.
    await persist(config, allOrganizations.length, resultStore.results(), [...runResults.values()]);
    log(`[checkpoint] resumed verified=${resumedVerified}, pending search=${unmatched.length}`);

    let persistChain = Promise.resolve();
    const checkpoint = async (organization: Organization, result: OrganizationResult): Promise<void> => {
      resultStore.upsert(organization, result);
      runResults.set(resultKeyForMerge(result), result);
      const failedStatuses = new Set(["unverified", "error", "not_found", "dns_failed", "http_failed"]);
      await updateSearchState(organization, failedStatuses.has(result.status) ? "failed" : "success");
      const completed = resultStore.results().filter((item) => selected.some((candidate) => candidate.originalName === item.name)).length;
      const success = resultStore.results().filter((item) => selected.some((candidate) => candidate.originalName === item.name) && !failedStatuses.has(item.status)).length;
      await writeSearchProgress({ taskId: config.taskId || `search_${process.pid}`, total: selected.length, processed: completed, success, failed: completed - success, currentInstitution: organization.originalName, status: completed >= selected.length ? "completed" : "running", lastUpdated: new Date().toISOString() });
      // Workers may finish together. Serialize writes so every checkpoint uses
      // an atomic replace and no two writes share the temporary output path.
      persistChain = persistChain.then(() => persist(config, allOrganizations.length, resultStore.results(), [...runResults.values()]));
      await persistChain;
    };
    await processSearxngBatch(unmatched, config.restore, config.searxngUrl, config.deepSearch, checkpoint);
    const merged = resultStore.results();
    if (config.deepSearch) await writeHardToFind(merged);
    if (config.showUnmatched) printUnmatched(merged);
    const processedResults = unmatched
      .map((organization) => resultStore.find(organization))
      .filter((result): result is OrganizationResult => Boolean(result));
    const newlyMatched = selected
      .filter((organization) => !unmatched.includes(organization) && !previousResults.some((result) => organizationKeys(organization).includes(resultKey(result.name))))
      .map((organization) => resultStore.find(organization))
      .filter((result): result is OrganizationResult => Boolean(result));
    logCompletionStats([...processedResults, ...newlyMatched], selected, resumedVerified + resumedOther);
    log(`[完成] SearXNG 结果已写入 ${config.output}`);
    return;
  }

  log(`[准备] 共需处理 ${selected.length} 个机构 (已跳过 0 个已验证的机构)`);
  const results = await processOnlineBatch(selected, config.restore);
  for (const [index, organization] of selected.entries()) {
    log(`[机构] 正在处理机构 ${organization.originalName} (${index + 1}/${selected.length})`);
    const failedStatuses = new Set(["unverified", "error", "not_found", "dns_failed", "http_failed", "whitelist_miss"]);
    await updateSearchState(organization, failedStatuses.has(results[index].status) ? "failed" : "success");
    const processed = index + 1;
    const success = results.slice(0, processed).filter((item) => !failedStatuses.has(item.status)).length;
    await writeSearchProgress({ taskId: config.taskId || `search_${process.pid}`, total: selected.length, processed, success, failed: processed - success, currentInstitution: organization.originalName, status: processed === selected.length ? "completed" : "running", lastUpdated: new Date().toISOString() });
  }
  await persist(config, allOrganizations.length, results);
  if (config.showUnmatched) printUnmatched(results);
  logCompletionStats(results, selected, 0);
  log(`[完成] 在线结果已写入 ${config.output}`);
}

function parseArguments(): Config {
  const config: Config = {
    input: DEFAULT_INPUT,
    whitelist: DEFAULT_WHITELIST,
    map: DEFAULT_MAP,
    output: DEFAULT_OUTPUT,
    mode: "online",
    restore: false,
    resume: false,
    dryRun: false,
    limit: Infinity,
    startAt: 0,
    showUnmatched: false,
    searxngUrl: (process.env.SEARXNG_URL || DEFAULT_SEARXNG_URL).replace(/\/+$/, ""),
    deepSearch: false,
    skipHours: 24,
    force: false,
    taskId: "",
  };
  const args = minimist(process.argv.slice(2), {
    boolean: ["offline", "searxng", "deep-search", "resume", "restore", "dry-run", "show-unmatched", "force", "help"],
    string: ["input", "whitelist", "desensitization-map", "output", "limit", "start-at", "skip-hours", "task-id"],
    default: { limit: Infinity, "start-at": 0 },
    alias: { h: "help" },
  });
  const known = new Set(["_", "offline", "searxng", "deep-search", "resume", "restore", "dry-run", "show-unmatched", "force", "help", "h", "input", "whitelist", "desensitization-map", "output", "limit", "start-at", "skip-hours", "task-id"]);
  const unknown = Object.keys(args).find((key) => !known.has(key));
  if (unknown) throw new Error(`未知参数: --${unknown}`);
  if (args.help) { printHelp(); process.exit(0); }
  if (args.offline) config.mode = "offline";
  if (args.searxng) config.mode = "searxng";
  if (args["deep-search"]) { config.mode = "deep-search"; config.deepSearch = true; }
  config.resume = Boolean(args.resume);
  config.restore = Boolean(args.restore);
  config.dryRun = Boolean(args["dry-run"]);
  config.showUnmatched = Boolean(args["show-unmatched"]);
  config.force = Boolean(args.force);
  if (args.input) config.input = resolve(String(args.input));
  if (args.whitelist) config.whitelist = resolve(String(args.whitelist));
  if (args["desensitization-map"]) config.map = resolve(String(args["desensitization-map"]));
  if (args.output) config.output = resolve(String(args.output));
  if (args.limit !== Infinity) config.limit = parseNonNegativeInteger(String(args.limit), "--limit");
  config.startAt = parseNonNegativeInteger(String(args["start-at"]), "--start-at");
  if (args["skip-hours"] !== undefined) config.skipHours = parseNonNegativeInteger(String(args["skip-hours"]), "--skip-hours");
  if (args["task-id"]) config.taskId = String(args["task-id"]);
  return config;
}

function printHelp(): void {
  console.log("Usage: npx tsx scripts/data-pipeline/discover_sources.ts [--offline|--searxng|--deep-search] [--skip-hours N] [--force] [--restore] [--dry-run] [--show-unmatched] [--limit N] [--start-at N] [--input FILE] [--whitelist FILE] [--desensitization-map FILE] [--output FILE]");
  console.log(`SearXNG URL: ${process.env.SEARXNG_URL || DEFAULT_SEARXNG_URL} (override with SEARXNG_URL)`);
  console.log("用法: npx tsx scripts/data-pipeline/discover_sources.ts [--offline|--searxng|--deep-search] [--restore] [--dry-run] [--show-unmatched] [--limit N] [--start-at N] [--input FILE] [--whitelist FILE] [--desensitization-map FILE] [--output FILE]");
}

function parseNonNegativeInteger(value: string, argument: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${argument} 必须是非负整数`);
  return number;
}

async function readOrganizations(inputPath: string, map: DesensitizationMap): Promise<Organization[]> {
  const raw = await readJson(inputPath);
  const values = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.organizations) ? raw.organizations : [];
  log(`[输入] 从 ${basename(inputPath)} 读取了 ${values.length} 个机构`);
  values.slice(0, 5).forEach((value, index) => {
    const record = isRecord(value) ? value : undefined;
    const rawName = typeof value === "string" ? value : typeof record?.name === "string" ? record.name : typeof record?.code === "string" ? record.code : "";
    log(`[输入] 原始名称${index + 1}: "${maskIdentifier(rawName)}"`);
  });
  const seen = new Set<string>();
  const organizations: Organization[] = [];
  for (const value of values) {
    const record = isRecord(value) ? value : undefined;
    const rawName = cleanIdentifier(
      typeof value === "string" ? value : typeof record?.name === "string" ? record.name : typeof record?.code === "string" ? record.code : "",
    );
    const explicitCode = typeof record?.code === "string" ? cleanIdentifier(record.code) : "";
    const originalName = explicitCode && map.codeToReal.has(explicitCode)
      ? map.codeToReal.get(explicitCode) || explicitCode
      : rawName;
    if (!originalName) continue;
    const identifier = explicitCode || map.realToCode.get(originalName) || originalName;
    if (seen.has(identifier)) continue;
    seen.add(identifier);
    const pinyin = typeof record?.pinyin === "string" ? cleanIdentifier(record.pinyin) : map.pinyinByCode.get(identifier);
    organizations.push({ originalName, identifier, pinyinHint: pinyin || undefined });
  }
  if (organizations.length === 0) throw new Error(`输入文件没有有效机构: ${inputPath}`);
  return organizations;
}

async function readEligibleOrganizationKeys(skipHours: number): Promise<Set<string>> {
  const cutoff = new Date(Date.now() - skipHours * 60 * 60 * 1000).toISOString();
  const result = await getDatabaseClient().execute({
    sql: `SELECT entity_id, slug, name FROM organizations
          WHERE search_status = 'pending' OR last_searched_at IS NULL OR last_searched_at < ?`,
    args: [cutoff],
  });
  const keys = new Set<string>();
  for (const row of result.rows) {
    for (const value of [row.entity_id, row.slug, row.name]) {
      if (typeof value === "string" && value.trim()) keys.add(resultKey(value));
    }
  }
  log(`[调度] skipHours=${skipHours} cutoff=${cutoff} eligibleRows=${result.rows.length}`);
  return keys;
}

async function updateSearchState(organization: Organization, status: SearchStatus): Promise<void> {
  const client = getDatabaseClient();
  const now = new Date().toISOString();
  log(`[机构] 正在更新数据库时间戳: ${organization.originalName} status=${status} at=${now}`);
  const candidates = unique([organization.originalName, organization.identifier]);
  const placeholders = candidates.map(() => "?").join(",");
  await client.execute({
    sql: `UPDATE organizations
          SET last_searched_at = ?, search_status = ?, updated_at = ?
          WHERE entity_id IN (${placeholders}) OR slug IN (${placeholders}) OR name IN (${placeholders})`,
    args: [now, status, now, ...candidates, ...candidates, ...candidates],
  });
  log(`[机构] 已更新数据库时间戳: ${organization.originalName}`);
}

async function readDesensitizationMap(path: string): Promise<DesensitizationMap> {
  const result: DesensitizationMap = { realToCode: new Map(), codeToReal: new Map(), pinyinByCode: new Map() };
  if (!existsSync(path)) return result;
  try {
    const raw = await readJson(path);
    if (!isRecord(raw)) return result;
    if (isRecord(raw.mapping)) {
      for (const [realName, codeValue] of Object.entries(raw.mapping)) {
        if (typeof codeValue !== "string") continue;
        const real = cleanIdentifier(realName);
        const code = cleanIdentifier(codeValue);
        if (real && code) {
          result.realToCode.set(real, code);
          result.codeToReal.set(code, real);
        }
      }
    }
    if (isRecord(raw.pinyin)) {
      for (const [code, pinyin] of Object.entries(raw.pinyin)) {
        if (typeof pinyin === "string" && cleanIdentifier(code) && cleanIdentifier(pinyin)) result.pinyinByCode.set(cleanIdentifier(code), cleanIdentifier(pinyin));
      }
    }
    if (Array.isArray(raw.organizations)) {
      for (const item of raw.organizations) {
        if (!isRecord(item) || typeof item.name !== "string" || typeof item.code !== "string") continue;
        const real = cleanIdentifier(item.name);
        const code = cleanIdentifier(item.code);
        if (!real || !code) continue;
        result.realToCode.set(real, code);
        result.codeToReal.set(code, real);
        if (typeof item.pinyin === "string" && cleanIdentifier(item.pinyin)) result.pinyinByCode.set(code, cleanIdentifier(item.pinyin));
      }
    }
    return result;
  } catch (error) {
    throw new Error(`无法读取脱敏映射 ${path}: ${formatError(error)}`);
  }
}

async function readWhitelist(path: string): Promise<WhitelistEntry[]> {
  let raw: unknown;
  try {
    raw = await readJson(path);
  } catch (error) {
    const message = `[白名单] 无法读取 ${path}: ${formatError(error)}`;
    log(message);
    throw new Error(message);
  }
  const values = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.institutions) ? raw.institutions
      : isRecord(raw) && Array.isArray(raw.organizations) ? raw.organizations
        : isRecord(raw) && Array.isArray(raw.entries) ? raw.entries : undefined;
  if (!values) {
    const message = `[白名单] 格式错误：${path} 缺少 institutions、organizations 或 entries 数组`;
    log(message);
    throw new Error(message);
  }
  const entries: WhitelistEntry[] = [];
  for (const value of values) {
    if (!isRecord(value)) continue;
    const name = typeof value.name === "string" ? cleanIdentifier(value.name) : undefined;
    const code = typeof value.code === "string" ? cleanIdentifier(value.code) : undefined;
    const aliases = Array.isArray(value.aliases) ? value.aliases.filter((alias): alias is string => typeof alias === "string").map(cleanIdentifier).filter(Boolean) : [];
    const sources = parseSources(value.domains ?? value.sources);
    if (typeof value.official_domain === "string" && value.official_domain.trim()) sources.unshift({ url: normalizeOfficialUrl(value.official_domain), type: "official" });
    if ((name || code || aliases.length > 0) && sources.length > 0) entries.push({ name, code, aliases, sources });
  }
  log(`[白名单] 从 ${path.split(/[\\/]/).pop()} 加载了 ${entries.length} 个条目`);
  return entries;
}

function processOffline(organization: Organization, whitelist: WhitelistEntry[], index: number, total: number, restore: boolean): OrganizationResult {
  const matched = whitelist.find((entry) => matchesEntry(entry, organization));
  log(`[匹配尝试] 机构: "${maskIdentifier(organization.originalName)}" -> 别名列表: ${JSON.stringify(matched?.aliases || [])}`);
  const name = restore ? organization.originalName : organization.identifier;
  if (matched) {
    log(`[${index + 1}/${total}] 处理机构: ${organization.identifier} (离线模式: 匹配成功)`);
    log(`[匹配结果] 是否找到: true`);
    log(`[成功] 匹配到域名: ${matched.sources[0]?.url || "未知"}`);
    const matchedBy = matched.code === organization.identifier ? "code" : matched.name === organization.identifier || matched.name === organization.originalName ? "name" : "alias";
    return { name, status: "whitelist_match", checkedAt: new Date().toISOString(), official_domain: domainFromSources(matched.sources), candidates: [], sources: matched.sources, matchedBy };
  }
  log(`[${index + 1}/${total}] 处理机构: ${organization.identifier} (离线模式: 未匹配)`);
  log(`[匹配结果] 是否找到: false`);
  log(`[失败] 原因: ${whitelist.length === 0 ? "白名单缺失" : "名称不匹配"}`);
  return { name, status: "whitelist_miss", checkedAt: new Date().toISOString(), official_domain: null, candidates: [], sources: [] };
}

function domainFromSources(sources: Source[]): string | null {
  for (const source of sources) {
    if (source.type === "secondary_source") continue;
    try {
      const parsed = new URL(source.url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      if (!isDisallowedDirectHost(host)) return host;
    } catch {
      // Ignore malformed whitelist entries; they are not emitted as domains.
    }
  }
  return null;
}

function matchesEntry(entry: WhitelistEntry, organization: Organization): boolean {
  return [entry.code, entry.name, ...entry.aliases].filter((value): value is string => Boolean(value)).some((value) => value.trim().toLocaleLowerCase() === organization.identifier.toLocaleLowerCase() || value.trim().toLocaleLowerCase() === organization.originalName.toLocaleLowerCase());
}

function normalizeOfficialUrl(domain: string): string {
  const value = domain.trim();
  return /^https?:\/\//i.test(value) ? value.replace(/\/$/, "") : `https://${value}`;
}

function maskIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return trimmed;
  return `${trimmed.slice(0, 2)}***${trimmed.slice(-1)}`;
}

function printUnmatched(results: OrganizationResult[]): void {
  const unmatched = results.filter((result) => result.status === "whitelist_miss" || result.status === "unverified");
  log(`[未匹配机构] 共 ${unmatched.length} 个`);
  unmatched.forEach((result) => log(`[未匹配机构] ${result.name}`));
}

function logCompletionStats(results: OrganizationResult[], _organizations: Organization[], skipped: number): void {
  const failedStatuses = new Set(["unverified", "error", "not_found", "dns_failed", "http_failed", "whitelist_miss"]);
  const failed = results.filter((result) => failedStatuses.has(result.status)).length;
  log(`[完成] 成功 ${Math.max(0, results.length - failed)} 个，失败 ${failed} 个，跳过 ${skipped} 个`);
}

function logSearxngWarning(organization: Organization, error: unknown, query?: string): void {
  const message = formatError(error);
  const status = message.match(/HTTP\s+(\d{3})/i)?.[1];
  const detail = status ? `HTTP ${status}` : message;
  const suffix = query ? `，查询: ${query}` : "";
  console.error(`\x1b[31m⚠️ SearXNG 请求失败 (${detail})，机构: ${organization.originalName}${suffix}\x1b[0m`);
}

function runDryRun(config: Config, organizations: Organization[]): void {
  log(`[dry-run] 不发起 DNS/HTTP 请求；预期处理机构数量=${organizations.length}`);
  for (const [index, organization] of organizations.entries()) {
    const candidates = generateCandidates(organization);
    if (config.mode === "searxng" || config.mode === "deep-search") {
      const simulatedUrls = ["https://www.wikipedia.org/wiki/example", `https://dry-run-${index + 1}.example.edu/`];
      log(`[dry-run] SearXNG 解析: ${organization.identifier} -> ${extractOfficialDomain(simulatedUrls) || "unverified"}`);
    }
    log(`[${index + 1}/${organizations.length}] 处理机构: ${organization.identifier} (dry-run: 候选域名=${candidates.join(", ") || "无"})`);
  }
  log(`[dry-run] 模拟完成，未写入 ${config.output}`);
}

interface SearxngResponse {
  results?: unknown;
}

function hostOf(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isDisallowedDirectHost(host: string): boolean {
  return DISALLOWED_DIRECT_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function createSearchProviders(searxngUrl: string, deepSearch: boolean): SearchProvider[] {
  const configured = (process.env.SEARCH_PROVIDERS || "searxng,brave,bing")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  // SearXNG remains the first, no-key provider. A Brave key opts the provider
  // into fallback automatically, even when SEARCH_PROVIDERS only says searxng.
  const searxngIndex = configured.indexOf("searxng");
  if (searxngIndex >= 0) configured.splice(searxngIndex, 1);
  configured.unshift("searxng");
  if (process.env.BRAVE_SEARCH_API_KEY?.trim() && !configured.includes("brave")) configured.push("brave");
  const providers: SearchProvider[] = [];
  for (const name of configured) {
    if (name === "searxng") providers.push({ name, search: (query) => querySearxngHits(searxngUrl, query, deepSearch) });
    if (name === "bing" && process.env.BING_SEARCH_API_KEY?.trim()) providers.push({ name, search: queryBing });
    if (name === "brave" && process.env.BRAVE_SEARCH_API_KEY?.trim()) providers.push({ name, search: queryBrave });
  }
  if (providers.length === 0) throw new Error("No search providers configured. Set SEARCH_PROVIDERS and provider API keys.");
  return providers;
}

async function querySearchProviders(providers: SearchProvider[], query: string): Promise<SearchHit[]> {
  // Providers are intentionally queried in order. This prevents a failed
  // SearXNG request from creating a burst against every external API.
  for (const provider of providers) {
    try {
      const hits = uniqueHits(await provider.search(query));
      if (hits.length > 0) {
        log(`[search] provider=${provider.name} query=\"${query}\" hits=${hits.length}`);
        return hits;
      }
      log(`[search] provider=${provider.name} query=\"${query}\" returned no results; trying fallback`);
    } catch (error) {
      log(`[${provider.name}] search failed for \"${query}\": ${formatError(error)}; trying fallback`);
    }
  }
  return [];
}

function uniqueHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => Boolean(hit.url.trim()) && !seen.has(hit.url.trim()) && Boolean(seen.add(hit.url.trim())));
}

async function processSearxngBatch(
  organizations: Organization[],
  restore: boolean,
  searxngUrl: string,
  deepSearch: boolean,
  onResult: (organization: Organization, result: OrganizationResult) => Promise<void>,
): Promise<OrganizationResult[]> {
  const results = new Array<OrganizationResult>(organizations.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= organizations.length) return;
      const organization = organizations[index];
      let result: OrganizationResult;
      try {
        result = await discoverWithSearxng(organization, restore, index + 1, organizations.length, searxngUrl, deepSearch);
      } catch (error) {
        result = { name: restore ? organization.originalName : organization.identifier, status: "unverified", checkedAt: new Date().toISOString(), official_domain: null, candidates: [], sources: [], error: formatError(error) };
        logSearxngWarning(organization, error);
      }
      results[index] = result;
      await onResult(organization, result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, organizations.length) }, () => worker()));
  return results;
}

async function discoverWithSearxng(organization: Organization, restore: boolean, position: number, total: number, searxngUrl: string, deepSearch = false): Promise<OrganizationResult> {
  return discoverWithExhaustiveSearch(organization, restore, position, total, searxngUrl, deepSearch);
}

const DEEP_SEARCH_SUFFIXES = [
  "有限公司", "有限责任公司", "股份有限公司", "集团有限公司", "公司", "集团", "研究中心", "研究院", "实验室", "中心", "大学", "学院", "委员会", "协会", "基金会", "研究所", "研究局",
  "co., ltd.", "co ltd", "company limited", "limited", "inc.", "inc", "llc", "corporation", "corp.", "corp",
  "research center", "research centre", "institute", "university", "college", "laboratory", "lab", "center", "centre", "foundation", "association", "agency", "bureau",
];

function cleanSearchName(value: string): string {
  let cleaned = value.replace(/[()（）[\]{}<>]/g, " ").replace(/["“”‘’]/g, " ").replace(/\s+/g, " ").trim();
  let changed = true;
  while (changed && cleaned) {
    changed = false;
    for (const suffix of DEEP_SEARCH_SUFFIXES) {
      const pattern = new RegExp(`(?:\\s*${suffix.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")})$`, "iu");
      const next = cleaned.replace(pattern, "").trim();
      if (next !== cleaned) changed = true;
      cleaned = next;
    }
  }
  return cleaned || value.trim();
}

function deepSearchQueries(organization: Organization): string[] {
  const name = organization.originalName.trim();
  return [`"${name}" 官网`, `"${name}" site:cn`, `"${name}" site:com`, `"${name}" homepage`];
}

function deepSearchTokens(organization: Organization): string[] {
  const core = cleanSearchName(organization.originalName);
  const asciiWords = core.normalize("NFKD").toLowerCase().match(/[a-z0-9]+/g) || [];
  const pinyin = (organization.pinyinHint || toPinyin(core)).toLowerCase().replace(/[^a-z0-9]/g, "");
  const abbreviation = asciiWords.length > 1 ? asciiWords.map((word) => word[0]).join("") : extractAbbreviation(core);
  const domainHints = Object.entries({ "科技": ["tech", "technology"], "软件": ["software"], "生物": ["bio", "biotech"], "医疗": ["medical", "health"], "金融": ["finance", "financial"], "教育": ["education", "edu"] })
    .filter(([term]) => core.includes(term))
    .flatMap(([, hints]) => hints);
  return unique([pinyin, asciiWords.join(""), ...asciiWords, abbreviation, ...domainHints])
    .map((token) => token.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((token) => token.length >= 2);
}

function extractHeuristicDomain(urls: string[], organization: Organization): string | null {
  const tokens = deepSearchTokens(organization);
  if (tokens.length === 0) return null;
  const hosts = unique(urls.map((value) => {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      return parsed.hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return "";
    }
  }).filter((host) => host && !isExcludedSearchHost(host)));
  const matched = hosts.filter((host) => {
    const compactHost = host.replace(/[^a-z0-9]/g, "");
    return tokens.some((token) => compactHost.includes(token));
  });
  return [...matched].sort((left, right) => officialHostScore(left) - officialHostScore(right))[0] || null;
}

function isMainstreamDomain(host: string): boolean {
  return /(^|\.)com$/.test(host) || /(^|\.)cn$/.test(host) || /(^|\.)net$/.test(host) || /(^|\.)com\.cn$/.test(host);
}

interface SearxngCandidate {
  url: string;
  host: string;
  token?: string;
}

/** Apply intentionally permissive filtering while explaining every decision. */
function filterSearxngResults(urls: string[], organization: Organization): SearxngCandidate[] {
  const tokens = deepSearchTokens(organization);
  const accepted: SearxngCandidate[] = [];
  for (const url of unique(urls)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      log(`[过滤] URL ${url} 无法解析`);
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      log(`[过滤] URL ${url} 使用不支持的协议`);
      continue;
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!host) {
      log(`[过滤] URL ${url} 缺少域名`);
      continue;
    }
    if (isExcludedSearchHost(host)) {
      log(`[过滤] 域名 ${host} 是明显的社交媒体/百科主页`);
      continue;
    }
    const compactHost = host.replace(/[^a-z0-9]/g, "");
    const token = tokens.find((candidate) => compactHost.includes(candidate));
    if (token) {
      log(`[匹配] 域名 ${host} 包含机构关键词 "${token}" (heuristic_match)`);
      accepted.push({ url, host, token });
      continue;
    }
    if (isMainstreamDomain(host)) {
      log(`[接受] 域名 ${host} 使用主流后缀，未命中关键词但保留作为回退`);
      accepted.push({ url, host });
      continue;
    }
    // Keep non-social domains as a last resort for institutions using an
    // uncommon country or industry TLD.
    log(`[接受] 域名 ${host} 非社交媒体主页，保留作为宽松回退`);
    accepted.push({ url, host });
  }
  return accepted;
}

interface FilteredSearchResults {
  accepted: SearxngCandidate[];
  blocked: SearchHit[];
}

function filterSearchResults(hits: SearchHit[], organization: Organization): FilteredSearchResults {
  const tokens = deepSearchTokens(organization);
  const accepted: SearxngCandidate[] = [];
  const blocked: SearchHit[] = [];
  for (const hit of uniqueHits(hits)) {
    const host = hostOf(hit.url);
    if (!host) continue;
    if (isDisallowedDirectHost(host)) {
      blocked.push(hit);
      continue;
    }
    const compactHost = host.replace(/[^a-z0-9]/g, "");
    const token = tokens.find((candidate) => compactHost.includes(candidate));
    accepted.push({ url: hit.url, host, token });
  }
  return { accepted, blocked };
}

async function referencesFromBlockedHits(hits: SearchHit[]): Promise<Source[]> {
  const links: Source[] = [];
  for (const hit of hits.slice(0, MAX_REFERENCE_LINKS)) {
    try {
      const response = await withTimeout(fetch(hit.url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { "user-agent": randomUserAgent(), accept: "text/html,*/*;q=0.5" } }), REQUEST_TIMEOUT_MS, `reference page ${hit.url}`);
      if (!response.ok) continue;
      const html = await readLimitedText(response);
      const $ = cheerio.load(html);
      $("a").each((_index, element) => {
        const label = $(element).text().trim().toLowerCase();
        const href = $(element).attr("href");
        if (!href || !(label.includes("参考") || label.includes("引用") || label.includes("reference") || label.includes("citation"))) return;
        try {
          const url = new URL(href, hit.url).toString();
          const host = hostOf(url);
          if (host && !isDisallowedDirectHost(host)) links.push({ url, title: $(element).text().trim(), type: "reference-candidate" });
        } catch { /* Ignore malformed reference URLs. */ }
      });
    } catch (error) {
      log(`[references] unable to inspect ${hit.url}: ${formatError(error)}`);
    }
  }
  const verified: Source[] = [];
  for (const source of uniqueSources(links).slice(0, MAX_REFERENCE_LINKS)) {
    try {
      let response = await withTimeout(fetch(source.url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { "user-agent": randomUserAgent() } }), REQUEST_TIMEOUT_MS, `reference verify ${source.url}`);
      // Some public sites reject HEAD while serving the same URL to GET.
      if (response.status === 405) response = await withTimeout(fetch(source.url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { "user-agent": randomUserAgent(), accept: "*/*" } }), REQUEST_TIMEOUT_MS, `reference verify ${source.url}`);
      if (response.status >= 200 && response.status < 400) verified.push({ ...source, type: "reference-validated" });
    } catch { /* A broken citation is intentionally omitted. */ }
  }
  return verified;
}

/** Keep blocked search hits available for review without treating them as official domains. */
function secondarySourcesFromBlockedHits(hits: SearchHit[], organization: Organization): Source[] {
  return uniqueSources(hits.map((hit): Source => {
    const source: Source = {
      url: hit.url,
      type: "secondary_source",
      provider: hit.provider,
      verified: false,
    };
    if (hit.title?.trim()) source.title = hit.title.trim();
    log(`[备选] 机构: ${organization.originalName}, 收录备选来源: ${hit.title?.trim() || hit.url} (${hit.url})`);
    return source;
  }));
}

async function readLimitedText(response: UndiciResponse): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (declaredLength > MAX_RESPONSE_BYTES) throw new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) throw new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  return body;
}

function uniqueSources(sources: Source[]): Source[] {
  const seen = new Set<string>();
  return sources.filter((source) => !seen.has(source.url) && Boolean(seen.add(source.url)));
}

async function discoverWithExhaustiveSearch(organization: Organization, restore: boolean, position: number, total: number, searxngUrl: string, deepSearch: boolean): Promise<OrganizationResult> {
  const name = restore ? organization.originalName : organization.identifier;
  const candidateUrls: string[] = [];
  const secondarySources: Source[] = [];
  const referenceSources: Source[] = [];
  const providers = createSearchProviders(searxngUrl, deepSearch);
  for (const query of deepSearchQueries(organization)) {
    log(`[深度搜索] 机构: ${organization.originalName} -> 尝试查询: ${query}`);
    let hits: SearchHit[] = [];
    try {
      // Use the broader engine pool for both modes; querySearxng retries
      // automatically without the engines parameter when unsupported.
      hits = await querySearchProviders(providers, query);
    } catch (error) {
      logSearxngWarning(organization, error, query);
    }
    candidateUrls.push(...hits.map((hit) => hit.url));
    const filtered = filterSearchResults(hits, organization);
    secondarySources.push(...secondarySourcesFromBlockedHits(filtered.blocked, organization));
    referenceSources.push(...await referencesFromBlockedHits(filtered.blocked));
    const selected = filtered.accepted.find((candidate) => candidate.token) || filtered.accepted[0];
    if (selected) {
      const status: ResultStatus = selected.token ? "heuristic_match" : "online_verified";
      const strategy = selected.token ? `heuristic_match(${selected.token})` : "relaxed_non_social_fallback";
      log(`[策略] 机构: ${organization.originalName} -> 查询 "${query}" -> ${strategy} -> ${selected.host}`);
      log(`[${position}/${total}] SearXNG 搜索成功: ${organization.identifier} -> ${selected.host}`);
      return { name, status, checkedAt: new Date().toISOString(), official_domain: selected.host, candidates: unique(candidateUrls).slice(0, MAX_CANDIDATES), sources: [{ url: selected.url, type: `${selected.token ? "heuristic" : "search"}:${hits.find((hit) => hit.url === selected.url)?.provider || "unknown"}` }, ...uniqueSources([...secondarySources, ...referenceSources])] };
    }
    log(`[深度搜索] 机构: ${organization.originalName} -> 失败 -> 进入下一查询`);
  }
  log(`[策略] 机构: ${organization.originalName} -> 四个查询均无可接受结果`);
  log(`[${position}/${total}] 深度搜索未找到: ${organization.originalName}`);
  return { name, status: "unverified", checkedAt: new Date().toISOString(), official_domain: null, candidates: unique(candidateUrls).slice(0, MAX_CANDIDATES), sources: uniqueSources([...secondarySources, ...referenceSources]) };
}

async function querySearxngHits(searxngUrl: string, query: string, deepSearch = false): Promise<SearchHit[]> {
  // SearXNG settings.yml must enable JSON: search.formats: [html, json].
  await jitterDelay();
  const baseEndpoint = `${searxngUrl.replace(/\/+$/, "")}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;
  const configuredEngines = (process.env.SEARXNG_ENGINES || "bing,duckduckgo,baidu").trim();
  const endpoint = deepSearch && configuredEngines ? `${baseEndpoint}&engines=${configuredEngines}` : baseEndpoint;
  const request = (url: string): Promise<UndiciResponse> => withTimeout(fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { "user-agent": randomUserAgent(), accept: "application/json", "accept-language": "en-US,en;q=0.8" } }), REQUEST_TIMEOUT_MS, `SearXNG ${query}`);
  let response = await request(endpoint);
  // Some deployments reject the engines parameter when one of the named
  // engines is disabled. Retry the same query with the configured general pool.
  if (!response.ok && deepSearch && response.status >= 400 && response.status < 500 && endpoint !== baseEndpoint) response = await request(baseEndpoint);
  if (!response.ok) throw new Error(`SearXNG HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (declaredLength > MAX_RESPONSE_BYTES) throw new Error(`SearXNG response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  const body = await withTimeout(response.text(), REQUEST_TIMEOUT_MS, "SearXNG response body");
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) throw new Error(`SearXNG response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  const parsed = JSON.parse(body) as SearxngResponse;
  if (!Array.isArray(parsed.results)) {
    log(`[SearXNG] 查询 "${query}" 原始结果数量=0（响应缺少 results 数组）`);
    return [];
  }
  log(`[SearXNG] 查询 "${query}" 原始结果数量=${parsed.results.length}`);
  const hits: SearchHit[] = [];
  parsed.results.forEach((result, index) => {
    if (!isRecord(result) || typeof result.url !== "string" || !result.url.trim()) {
      log(`[过滤] 搜索结果 #${index + 1} 缺少有效 URL`);
      return;
    }
    hits.push({ url: result.url.trim(), provider: "searxng", title: typeof result.title === "string" ? result.title : undefined, snippet: typeof result.content === "string" ? result.content : undefined });
  });
  return hits;
}

async function queryBing(query: string): Promise<SearchHit[]> {
  await jitterDelay();
  const endpoint = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=10&responseFilter=Webpages`;
  const response = await withTimeout(fetch(endpoint, { headers: { "Ocp-Apim-Subscription-Key": process.env.BING_SEARCH_API_KEY!.trim(), accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }), REQUEST_TIMEOUT_MS, `Bing ${query}`);
  if (!response.ok) throw new Error(`Bing HTTP ${response.status}`);
  const body = await response.json() as { webPages?: { value?: Array<{ url?: string; name?: string; snippet?: string }> } };
  return (body.webPages?.value || []).flatMap((item) => typeof item.url === "string" ? [{ url: item.url, provider: "bing", title: item.name, snippet: item.snippet }] : []);
}

async function queryBrave(query: string): Promise<SearchHit[]> {
  await jitterDelay();
  const endpoint = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`;
  const response = await withTimeout(fetch(endpoint, { headers: { "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY!.trim(), accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }), REQUEST_TIMEOUT_MS, `Brave ${query}`);
  if (!response.ok) throw new Error(`Brave HTTP ${response.status}`);
  const body = await response.json() as { web?: { results?: Array<{ url?: string; title?: string; description?: string }> } };
  return (body.web?.results || []).flatMap((item) => typeof item.url === "string" ? [{ url: item.url, provider: "brave", title: item.title, snippet: item.description }] : []);
}

function extractOfficialDomain(urls: string[]): string | null {
  const hosts = unique(urls.map((value) => { try { const parsed = new URL(value); if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return ""; return parsed.hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } }).filter((host) => host && !isExcludedSearchHost(host)));
  return [...hosts].sort((left, right) => officialHostScore(left) - officialHostScore(right))[0] || null;
}

function isPreferredOfficialHost(host: string): boolean {
  return /(^|\.)edu(\.|$)/.test(host) || /(^|\.)org(\.|$)/.test(host) || /(^|\.)gov(\.|$)/.test(host) || /(^|\.)ac\.cn$/.test(host);
}

function officialHostScore(host: string): number {
  if (/(^|\.)edu(\.|$)/.test(host)) return 0;
  if (/(^|\.)ac\.cn$/.test(host) || /(^|\.)gov(\.|$)/.test(host)) return 1;
  if (/(^|\.)org(\.|$)/.test(host)) return 2;
  return 10;
}

function isExcludedSearchHost(host: string): boolean {
  return isDisallowedDirectHost(host);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

async function processOnlineBatch(organizations: Organization[], restore: boolean): Promise<OrganizationResult[]> {
  const results: OrganizationResult[] = [];
  for (let start = 0; start < organizations.length; start += MAX_CONCURRENCY) {
    const batch = organizations.slice(start, start + MAX_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((organization, offset) => probeOrganization(organization, restore, start + offset + 1, organizations.length)));
    settled.forEach((item, offset) => {
      const organization = batch[offset];
      if (item.status === "fulfilled") {
        results.push(item.value);
      } else {
        results.push({ name: restore ? organization.originalName : organization.identifier, status: "error", checkedAt: new Date().toISOString(), official_domain: null, candidates: generateCandidates(organization), sources: [], error: formatError(item.reason) });
        log(`[${start + offset + 1}/${organizations.length}] 处理机构: ${organization.identifier} (在线模式: 处理异常)`);
      }
    });
  }
  return results;
}

async function probeOrganization(organization: Organization, restore: boolean, position: number, total: number): Promise<OrganizationResult> {
  const candidates = generateCandidates(organization);
  const probes: DomainProbe[] = [];
  let sawDnsFailure = false;
  let sawHttpFailure = false;
  for (const domain of candidates) {
    log(`[${position}/${total}] 开始探测: ${organization.identifier} -> ${domain}`);
    const probe: DomainProbe = { domain, dns: "failed" };
    try {
      await jitterDelay();
      await lookupPublic(domain);
      probe.dns = "ok";
    } catch (error) {
      sawDnsFailure = true;
      probe.error = formatError(error);
      probes.push(probe);
      continue;
    }
    try {
      probe.root = await fetchEndpoint(domain, "/");
      probe.robots = await fetchEndpoint(domain, "/robots.txt");
      probes.push(probe);
      const reachable = [probe.root, probe.robots].some((item) => item !== undefined && item.status >= 200 && item.status < 400);
      if (reachable) {
        log(`[${position}/${total}] 处理机构: ${organization.identifier} (在线模式: HTTP 探测成功 ${domain})`);
        return { name: restore ? organization.originalName : organization.identifier, status: "online_verified", checkedAt: new Date().toISOString(), official_domain: domain, candidates, sources: [{ url: `https://${domain}/`, type: "candidate" }], probes };
      }
      sawHttpFailure = true;
    } catch (error) {
      sawHttpFailure = true;
      probe.error = formatError(error);
      probes.push(probe);
    }
  }
  const status: ResultStatus = sawHttpFailure ? "http_failed" : sawDnsFailure ? "dns_failed" : "not_found";
  const reason = status === "dns_failed" ? "DNS解析失败" : status === "http_failed" ? "HTTP探测失败" : "未找到";
  log(`[${position}/${total}] 处理机构: ${organization.identifier} (在线模式: ${reason})`);
  return { name: restore ? organization.originalName : organization.identifier, status, checkedAt: new Date().toISOString(), official_domain: null, candidates, sources: [], probes };
}

async function lookupPublic(domain: string): Promise<DnsAddress[]> {
  const cached = dnsCache.get(domain);
  if (cached) return cached;
  const operation = withTimeout(lookup(domain, { all: true, verbatim: true }), REQUEST_TIMEOUT_MS, `DNS ${domain}`).then((addresses) => {
    if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address.address))) throw new Error("DNS result is private or empty");
    return addresses;
  });
  dnsCache.set(domain, operation);
  try {
    return await operation;
  } catch (error) {
    dnsCache.delete(domain);
    throw error;
  }
}

async function fetchEndpoint(domain: string, path: "/" | "/robots.txt"): Promise<HttpProbe> {
  await jitterDelay();
  const response = await withTimeout(fetch(`https://${domain}${path}`, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      "user-agent": randomUserAgent(),
      accept: path === "/robots.txt" ? "text/plain,*/*;q=0.5" : "text/html,application/xhtml+xml,*/*;q=0.5",
      "accept-language": "en-US,en;q=0.8",
    },
  }), REQUEST_TIMEOUT_MS, `HTTP ${domain}${path}`);
  const contentType = response.headers.get("content-type") || undefined;
  await withTimeout(consumeLimitedBody(response), REQUEST_TIMEOUT_MS, `HTTP body ${domain}${path}`);
  return { path, status: response.status, contentType };
}

async function consumeLimitedBody(response: UndiciResponse): Promise<void> {
  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error(`HTTP response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`HTTP response exceeds ${MAX_RESPONSE_BYTES} bytes`);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function generateCandidates(organization: Organization): string[] {
  const candidates: string[] = [];
  const add = (value: string): void => {
    const normalized = value.toLowerCase().replace(/[^a-z0-9.-]/g, "").replace(/\.{2,}/g, ".").replace(/^-+|-+$/g, "");
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };
  const seed = organization.identifier;
  const words = seed.normalize("NFKD").toLowerCase().match(/[a-z0-9]+/g) || [];
  const joined = words.join("");
  const hyphenated = words.join("-");
  if (joined) {
    add(`${joined}.edu`);
    add(`${joined}.org`);
  }
  if (hyphenated && hyphenated !== joined) {
    add(`${hyphenated}.edu`);
    add(`${hyphenated}.org`);
  }
  const abbreviation = words.length > 1 ? words.map((word) => word[0]).join("") : extractAbbreviation(seed);
  if (abbreviation.length >= 2) {
    add(`${abbreviation}.edu`);
    add(`${abbreviation}.org`);
  }
  if (organization.pinyinHint || /[\u3400-\u9fff]/u.test(seed)) {
    const pinyin = (organization.pinyinHint || toPinyin(seed)).replace(/[^a-z0-9]+/gi, "").toLowerCase();
    if (pinyin) {
      add(`${pinyin}.edu.cn`);
      add(`${pinyin}.ac.cn`);
    }
  }
  return candidates.slice(0, MAX_CANDIDATES);
}

function extractAbbreviation(value: string): string {
  return (value.match(/\b[A-Z][A-Z0-9]{1,8}\b/g)?.join("") || "").toLowerCase();
}

function toPinyin(value: string): string {
  const compact = value.replace(/\s+/g, "");
  if (PINYIN_PHRASES[compact]) return PINYIN_PHRASES[compact];
  return [...compact].map((character) => PINYIN_CHARACTERS[character] || (/^[a-z0-9]$/i.test(character) ? character : "")).join("");
}

// A small offline dictionary avoids a runtime transliteration dependency.
// Operators can provide exact pinyin in desensitization_map.json when needed.
const PINYIN_PHRASES: Record<string, string> = {
  北京大学: "beijingdaxue",
  清华大学: "qinghuadaxue",
  上海交通大学: "shanghaijiaotongdaxue",
  东京大学: "dongjingdaxue",
  京都大学: "jingdudaxue",
  浙江大学: "zhejiangdaxue",
  南京大学: "nanjingdaxue",
  复旦大学: "fudandaxue",
  中国科学院: "zhongguokexueyuan",
};

const PINYIN_CHARACTERS: Record<string, string> = {
  北: "bei", 京: "jing", 大: "da", 学: "xue", 清: "qing", 华: "hua", 上: "shang", 海: "hai", 交: "jiao", 通: "tong", 东: "dong", 日: "ri", 本: "ben", 科: "ke", 技: "ji", 研: "yan", 究: "jiu", 深: "shen", 蓝: "lan", 中: "zhong", 国: "guo", 院: "yuan", 浙: "zhe", 江: "jiang", 南: "nan", 复: "fu", 旦: "dan",
};

function parseSources(value: unknown): Source[] {
  if (!Array.isArray(value)) return [];
  const sources: Source[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      sources.push({ url: item.trim() });
    } else if (isRecord(item) && typeof item.url === "string" && item.url.trim()) {
      const source: Source = { url: item.url.trim() };
      if (typeof item.title === "string") source.title = item.title;
      if (typeof item.type === "string") source.type = item.type;
      if (typeof item.provider === "string") source.provider = item.provider;
      if (typeof item.verified === "boolean") source.verified = item.verified;
      sources.push(source);
    }
  }
  return sources;
}

function buildOutput(config: Config, inputOrganizations: number, results: OrganizationResult[], statsResults = results): PersistedOutput {
  const organizations = [...results].sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  const count = (status: ResultStatus): number => statsResults.filter((item) => item.status === status).length;
  const onlineVerified = count("online_verified") + count("verified");
  return {
    schemaVersion: "organization-sources-secure/v1",
    generatedAt: new Date().toISOString(),
    mode: config.mode,
    restoredNames: config.restore,
    stats: {
      inputOrganizations,
      processedOrganizations: organizations.length,
      whitelistMatches: count("whitelist_match"),
      whitelistMisses: count("whitelist_miss"),
      onlineVerified,
      searxngVerified: config.mode === "searxng" || config.mode === "deep-search" ? onlineVerified : 0,
      heuristicMatches: count("heuristic_match"),
      unverified: count("unverified"),
      notFound: count("not_found"),
      dnsFailed: count("dns_failed"),
      httpFailed: count("http_failed"),
      errors: count("error"),
    },
    organizations,
  };
}

const existingResultsCache = new Map<string, OrganizationResult[]>();
const backupOutputs = new Set<string>();

function resultKeyForMerge(result: OrganizationResult): string {
  return cleanIdentifier(result.name).toLocaleLowerCase();
}

function mergeResults(existing: OrganizationResult[], current: OrganizationResult[]): OrganizationResult[] {
  const merged = new Map<string, OrganizationResult>();
  for (const result of existing) merged.set(resultKeyForMerge(result), result);
  for (const result of current) merged.set(resultKeyForMerge(result), result);
  return [...merged.values()];
}

function backupSuffix(): string {
  return new Date().toISOString().replace(/[T:]/g, "-").replace(/\.\d{3}Z$/, "Z");
}

async function persist(config: Config, inputOrganizations: number, results: OrganizationResult[], statsResults = results): Promise<void> {
  let existing = existingResultsCache.get(config.output);
  if (!existing) {
    existing = existsSync(config.output) ? await readPersistedResults(config.output) : [];
    existingResultsCache.set(config.output, existing);
  }
  const mergedResults = mergeResults(existing, results);
  existingResultsCache.set(config.output, mergedResults);
  if (existsSync(config.output) && !backupOutputs.has(config.output)) {
    const backupPath = `${config.output}.bak_${backupSuffix()}`;
    await copyFile(config.output, backupPath);
    backupOutputs.add(config.output);
    log(`[backup] existing results backed up to ${backupPath}`);
  }
  const temporaryPath = `${config.output}.${process.pid}.tmp`;
  await mkdir(dirname(config.output), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(buildOutput(config, inputOrganizations, mergedResults, statsResults), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, config.output);
  log(`[checkpoint] saved ${mergedResults.length} total organization results (${results.length} current)`);
}

interface SearchProgressSnapshot {
  taskId: string;
  total: number;
  processed: number;
  success: number;
  failed: number;
  currentInstitution: string | null;
  status: "running" | "completed" | "failed";
  message?: string;
  lastUpdated: string;
}

async function writeSearchProgress(snapshot: SearchProgressSnapshot): Promise<void> {
  await mkdir(dirname(SEARCH_PROGRESS_PATH), { recursive: true });
  // This file is read by the admin polling endpoint. On Windows, replacing it
  // with rename can fail with EPERM while the reader has it open.
  await writeFile(SEARCH_PROGRESS_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function writeHardToFind(results: OrganizationResult[]): Promise<void> {
  const hardToFindPath = resolve(PROJECT_ROOT, "data", "hard_to_find.json");
  const hardToFind = results
    .filter((result) => (result.status === "unverified" || result.status === "error") && !result.official_domain)
    .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"))
    .map((result) => ({
      name: result.name,
      status: result.status,
      checkedAt: result.checkedAt,
      candidates: result.candidates,
      error: result.error,
    }));
  const temporaryPath = `${hardToFindPath}.${process.pid}.tmp`;
  await mkdir(dirname(hardToFindPath), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), organizations: hardToFind }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, hardToFindPath);
  log(`[深度搜索] 仍未找到 ${hardToFind.length} 个机构，已写入 ${hardToFindPath}`);
}

async function readPersistedResults(outputPath: string): Promise<OrganizationResult[]> {
  if (!existsSync(outputPath)) return [];

  let raw: unknown;
  try {
    raw = await readJson(outputPath);
  } catch (error) {
    throw new Error(`Unable to read existing checkpoint ${outputPath}; refusing to overwrite it: ${formatError(error)}`);
  }
  if (!isRecord(raw) || !Array.isArray(raw.organizations)) {
    throw new Error(`Existing checkpoint ${outputPath} has no organizations array; refusing to overwrite it`);
  }

  const results = raw.organizations.map((value, index) => parsePersistedResult(value, index, outputPath));
  log(`[checkpoint] loaded ${results.length} existing organization results`);
  return results;
}

function parsePersistedResult(value: unknown, index: number, outputPath: string): OrganizationResult {
  if (!isRecord(value)) throw new Error(`Existing checkpoint ${outputPath} has an invalid organization at index ${index}`);
  const name = typeof value.name === "string" ? cleanIdentifier(value.name) : "";
  const status = typeof value.status === "string" ? cleanIdentifier(value.status) : "";
  if (!name || !status) throw new Error(`Existing checkpoint ${outputPath} has an organization without name or status at index ${index}`);

  const result: OrganizationResult = {
    name,
    status,
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : "",
    official_domain: typeof value.official_domain === "string" && value.official_domain.trim() ? value.official_domain.trim() : null,
    candidates: Array.isArray(value.candidates) ? value.candidates.filter((candidate): candidate is string => typeof candidate === "string") : [],
    sources: parseSources(value.sources),
  };
  if (Array.isArray(value.probes)) result.probes = value.probes.map(parsePersistedProbe).filter((probe): probe is DomainProbe => probe !== undefined);
  if (value.matchedBy === "name" || value.matchedBy === "code" || value.matchedBy === "alias") result.matchedBy = value.matchedBy;
  if (typeof value.error === "string") result.error = value.error;
  return result;
}

function parsePersistedProbe(value: unknown): DomainProbe | undefined {
  if (!isRecord(value) || typeof value.domain !== "string" || (value.dns !== "ok" && value.dns !== "failed")) return undefined;
  const probe: DomainProbe = { domain: value.domain, dns: value.dns };
  const parseHttpProbe = (candidate: unknown, path: "/" | "/robots.txt"): HttpProbe | undefined => {
    if (!isRecord(candidate) || candidate.path !== path || typeof candidate.status !== "number") return undefined;
    const httpProbe: HttpProbe = { path, status: candidate.status };
    if (typeof candidate.contentType === "string") httpProbe.contentType = candidate.contentType;
    return httpProbe;
  };
  probe.root = parseHttpProbe(value.root, "/");
  probe.robots = parseHttpProbe(value.robots, "/robots.txt");
  if (typeof value.error === "string") probe.error = value.error;
  return probe;
}

function createResultStore(previousResults: OrganizationResult[]): ResultStore {
  const stored = [...previousResults];
  const indexes = new Map<string, number>();

  const setIndex = (name: string, index: number): void => {
    const key = resultKey(name);
    if (key) indexes.set(key, index);
  };
  stored.forEach((result, index) => setIndex(result.name, index));

  const findIndex = (organization: Organization): number | undefined => {
    for (const key of organizationKeys(organization)) {
      const index = indexes.get(key);
      if (index !== undefined) return index;
    }
    return undefined;
  };

  return {
    find(organization): OrganizationResult | undefined {
      const index = findIndex(organization);
      return index === undefined ? undefined : stored[index];
    },
    upsert(organization, result): void {
      const existingIndex = findIndex(organization);
      const index = existingIndex === undefined ? stored.push(result) - 1 : existingIndex;
      if (existingIndex !== undefined) stored[index] = result;
      setIndex(result.name, index);
      for (const key of organizationKeys(organization)) indexes.set(key, index);
    },
    results(): OrganizationResult[] {
      return [...stored];
    },
  };
}

function organizationKeys(organization: Organization): string[] {
  return unique([resultKey(organization.originalName), resultKey(organization.identifier)]);
}

function resultKey(value: string): string {
  return cleanIdentifier(value).toLocaleLowerCase();
}

function isResumeSkipResult(result: OrganizationResult): boolean {
  return result.status === "whitelist_match" || result.status === "verified" || result.status === "online_verified" || result.status === "heuristic_match";
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function jitterDelay(): Promise<void> {
  // Serialize search starts across workers. This enforces a 2-4 second gap
  // between SearXNG/Brave/Bing requests and avoids IP-based rate-limit bursts.
  const delay = BASE_DELAY_MS + Math.floor(Math.random() * (JITTER_MS + 1));
  const scheduledAt = Math.max(Date.now(), nextSearchRequestAt);
  nextSearchRequestAt = scheduledAt + delay;
  await sleep(Math.max(0, scheduledAt - Date.now()));
}

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] || USER_AGENTS[0];
}

function withTimeout<T>(operation: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${milliseconds}ms`)), milliseconds);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [first, second] = address.split(".").map(Number);
    if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
    if (first === 100 && second >= 64 && second <= 127) return false;
    if (first === 169 && second === 254) return false;
    if (first === 172 && second >= 16 && second <= 31) return false;
    if (first === 192 && (second === 0 || second === 168)) return false;
    if (first === 198 && (second === 18 || second === 19 || second === 51)) return false;
    if (first === 203 && second === 0) return false;
    return true;
  }
  const normalized = address.toLowerCase();
  return normalized !== "::1" && !normalized.startsWith("fc") && !normalized.startsWith("fd") && !normalized.startsWith("fe8") && !normalized.startsWith("fe9") && !normalized.startsWith("fea") && !normalized.startsWith("feb") && !normalized.startsWith("2001:db8");
}

function cleanIdentifier(value: string): string {
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

process.once("exit", closeDatabaseClient);

main().catch((error: unknown) => {
  console.error(`${new Date().toISOString()} [失败] ${formatError(error)}`);
  process.exitCode = 1;
});
