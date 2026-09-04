import OpenAI from "openai";
import { CONFIG } from "./config";

const baseURL = CONFIG.LLM_BASE_URL.replace(/\/+$/, "");
const apiKey = CONFIG.LLM_API_KEY;
export const LLM_MODEL_NAME = CONFIG.LLM_MODEL_NAME;

const client = new OpenAI({ baseURL, apiKey, maxRetries: CONFIG.LLM_MAX_RETRIES });

export type ChatCompletionOptions = {
  model?: string;
  timeout?: number;
  jsonMode?: boolean;
  [key: string]: unknown;
};

function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const value = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  if (value?.name === "APIConnectionError" || value?.name === "APIConnectionTimeoutError") return true;
  const code = typeof value?.code === "string" ? value.code : typeof value?.cause?.code === "string" ? value.cause.code : "";
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|network|timeout/i.test(`${code} ${message}`);
}

function completionText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    return part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "";
  }).join("").trim();
}

function isResponseFormatUnsupported(error: unknown): boolean {
  const value = error as { status?: unknown; message?: unknown; error?: { message?: unknown } } | null;
  const status = value?.status;
  const nestedMessage = value?.error?.message;
  const message = [
    error instanceof Error ? error.message : "",
    typeof value?.message === "string" ? value.message : "",
    typeof nestedMessage === "string" ? nestedMessage : "",
  ].join(" ");
  const mentionsJsonMode = /response[_ -]?format|json[_ -]?object/i.test(message);
  const describesUnsupported = /unsupported|not supported|invalid|unknown parameter|unrecognized/i.test(message);
  return mentionsJsonMode && (status === 400 || status === 422 || describesUnsupported);
}

function requestPayload(systemPrompt: string, userPrompt: string, options: ChatCompletionOptions, jsonMode: boolean): Record<string, unknown> {
  const requestOptions = { ...options };
  delete requestOptions.jsonMode;
  delete requestOptions.timeout;
  return {
    ...requestOptions,
    model: options.model || LLM_MODEL_NAME,
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
    temperature: 0.1,
    stream: true,
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
  };
}

type ChatCompletionChunk = {
  choices?: Array<{ delta?: { content?: unknown } }>;
};

async function collectStream(stream: unknown): Promise<string> {
  let response = "";
  for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
    const content = chunk.choices?.[0]?.delta?.content;
    if (typeof content === "string") response += content;
    else if (Array.isArray(content)) response += completionText(content);
  }
  return response.trim();
}

/** Call any OpenAI-compatible chat endpoint, including Ollama and internal models. */
export async function chatCompletion(systemPrompt: string, userPrompt: string, options: ChatCompletionOptions = {}): Promise<string> {
  let lastError: unknown;
  let jsonModeEnabled = options.jsonMode === true;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      let stream: unknown;
      try {
        stream = await client.chat.completions.create({ ...requestPayload(systemPrompt, userPrompt, options, jsonModeEnabled), stream: true } as never, { timeout: options.timeout as number | undefined } as never);
      } catch (error) {
        if (!jsonModeEnabled || !isResponseFormatUnsupported(error)) throw error;
        jsonModeEnabled = false;
        console.warn("[llm] response_format 不受当前服务商支持，降级为 Prompt-only JSON 约束");
        stream = await client.chat.completions.create({ ...requestPayload(systemPrompt, userPrompt, options, false), stream: true } as never, { timeout: options.timeout as number | undefined } as never);
      }
      const text = await collectStream(stream);
      if (!text) throw new Error("LLM returned an empty completion");
      return text;
    } catch (error) {
      lastError = error;
      if (attempt === 0 && isNetworkError(error)) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
