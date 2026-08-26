const PUBLIC_SUFFIXES = new Set(["co.uk", "org.uk", "ac.uk", "com.au", "co.jp", "co.nz"]);

export function officialSiteKey(value) {
  const host = String(value ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").split(/[/?#]/, 1)[0].replace(/^www\./, "");
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return host;
  const suffix = labels.slice(-2).join(".");
  return labels.length >= 3 && PUBLIC_SUFFIXES.has(suffix) ? labels.slice(-3).join(".") : labels.slice(-2).join(".");
}
