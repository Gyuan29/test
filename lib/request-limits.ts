export function createRateLimiter(maxRequests: number, windowMs: number) {
  const buckets = new Map<string, { startedAt: number; count: number }>();
  return { allow(key: string): boolean { const now = Date.now(); const bucket = buckets.get(key); if (!bucket || now - bucket.startedAt >= windowMs) { buckets.set(key, { startedAt: now, count: 1 }); return true; } if (bucket.count >= maxRequests) return false; bucket.count += 1; return true; } };
}

