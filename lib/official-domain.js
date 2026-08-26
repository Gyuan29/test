const GENERIC_PLATFORM_ROOTS = [
  "baidu.com",
  "bilibili.com",
  "douban.com",
  "facebook.com",
  "google.com",
  "instagram.com",
  "linkedin.com",
  "play.google.com",
  "quora.com",
  "reddit.com",
  "twitter.com",
  "wikipedia.org",
  "wikimedia.org",
  "weibo.com",
  "x.com",
  "youtube.com",
  "zhihu.com",
];

function isGenericPlatform(host) {
  return GENERIC_PLATFORM_ROOTS.some((root) => host === root || host.endsWith(`.${root}`));
}

export function normalizeOfficialDomain(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const candidate = value.trim();
  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//iu.test(candidate) ? candidate : `https://${candidate}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./u, "");
  if (!host || host.length > 253 || isGenericPlatform(host)) return null;
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) return null;
  const topLevelDomain = labels.at(-1);
  if (!topLevelDomain || !/^[a-z]{2,63}$/u.test(topLevelDomain)) return null;
  return host;
}
