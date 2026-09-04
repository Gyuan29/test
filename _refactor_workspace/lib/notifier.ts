export type WebhookProvider = "feishu" | "dingtalk" | "wework" | "generic";

export interface SendWebhookOptions {
  provider: WebhookProvider;
  url: string;
  title: string;
  markdown: string;
  timeoutMs?: number;
  retries?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

export interface WebhookResult {
  ok: boolean;
  status: number;
  provider: WebhookProvider;
  attempts: number;
  error?: string;
}

function payloadFor(options: SendWebhookOptions, markdown: string): Record<string, unknown> {
  switch (options.provider) {
    case "feishu":
      return {
        msg_type: "interactive",
        card: { schema: "2.0", body: { elements: [{ tag: "markdown", content: `**${options.title}**\n\n${markdown}` }] } },
      };
    case "dingtalk":
      return { msgtype: "markdown", markdown: { title: options.title, text: `### ${options.title}\n\n${markdown}` } };
    case "wework":
      return { msgtype: "markdown", markdown: { content: `# ${options.title}\n${markdown}` } };
    case "generic":
      return { title: options.title, content: markdown };
  }
}

function splitByBytes(value: string, maxBytes: number): string[] {
  if (new TextEncoder().encode(value).length <= maxBytes) return [value];
  const chunks: string[] = [];
  let current = "";
  for (const line of value.split(/\r?\n/)) {
    const candidate = current ? `${current}\n${line}` : line;
    if (new TextEncoder().encode(candidate).length > maxBytes && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [value.slice(0, maxBytes)];
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

function isSuccessPayload(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  const record = value as Record<string, unknown>;
  const code = record.code ?? record.errcode ?? record.StatusCode;
  return code === undefined || code === 0 || code === "0";
}

export async function sendWebhook(options: SendWebhookOptions): Promise<WebhookResult> {
  let target: URL;
  try {
    target = new URL(options.url);
  } catch {
    return { ok: false, status: 0, provider: options.provider, attempts: 0, error: "invalid webhook URL" };
  }
  if (!/^https?:$/.test(target.protocol)) return { ok: false, status: 0, provider: options.provider, attempts: 0, error: "webhook URL must use HTTP(S)" };
  const fetchImpl = options.fetchImpl ?? fetch;
  const retries = Math.max(0, Math.min(options.retries ?? 2, 5));
  const chunks = splitByBytes(options.markdown, options.maxBytes ?? 18_000);
  let attempts = 0;
  let lastError = "webhook request failed";
  let lastStatus = 0;
  for (const chunk of chunks) {
    let delivered = false;
    for (let retry = 0; retry <= retries; retry += 1) {
      attempts += 1;
      try {
        const response = await fetchImpl(target, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(payloadFor(options, chunk)),
          signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        });
        lastStatus = response.status;
        const responseText = await response.text();
        let responseBody: unknown = undefined;
        try { responseBody = responseText ? JSON.parse(responseText) as unknown : undefined; } catch { /* non-JSON success responses are valid for generic hooks */ }
        if (response.ok && isSuccessPayload(responseBody)) {
          delivered = true;
          break;
        }
        lastError = responseText || `HTTP ${response.status}`;
        if (!isRetryableStatus(response.status)) break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (retry < retries) await new Promise((resolve) => setTimeout(resolve, 250 * (retry + 1)));
    }
    if (!delivered) return { ok: false, status: lastStatus, provider: options.provider, attempts, error: lastError };
  }
  return { ok: true, status: lastStatus || 200, provider: options.provider, attempts };
}

