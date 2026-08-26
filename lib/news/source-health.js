export function classifySourceHealth({ status, errorCode } = {}) {
  if (status === 403 || status === 401) return { health: "blocked", retryClass: "manual" };
  if (status === 404 || status === 410) return { health: "missing", retryClass: "reprobe" };
  if (status === 429) return { health: "rate_limited", retryClass: "backoff" };
  if (errorCode === "ETIMEDOUT" || errorCode === "ABORT_ERR") return { health: "timeout", retryClass: "retry" };
  return { health: "failed", retryClass: "retry" };
}
