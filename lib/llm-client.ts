import OpenAI from "openai";

const baseURL = (process.env.LLM_BASE_URL?.trim() || "http://localhost:11434/v1").replace(/\/+$/, "");
const apiKey = process.env.LLM_API_KEY?.trim() || "ollama";
export const LLM_MODEL_NAME = process.env.LLM_MODEL_NAME?.trim() || "qwen2.5:3b";

const client = new OpenAI({ baseURL, apiKey, maxRetries: 0 });

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

/** Call any OpenAI-compatible chat endpoint, including Ollama and internal models. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function chatCompletion(systemPrompt: string, userPrompt: string, options: any = {}): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const completion = await client.chat.completions.create({
        ...options,
        model: options.model || LLM_MODEL_NAME,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
        temperature: 0.1,
      });
      const text = completionText(completion.choices?.[0]?.message?.content);
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
