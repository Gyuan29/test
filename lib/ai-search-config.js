const OPENAI_COMPATIBLE_PROVIDERS = new Set(["custom", "openrouter", "deepseek", "openai"]);

export function canStartAiSearch({ provider, apiKeyConfigured, busy }) {
  return !busy && Boolean(apiKeyConfigured) && OPENAI_COMPATIBLE_PROVIDERS.has(provider);
}

export function resolveAiSearchModel(model) {
  return typeof model === "string" && model.trim() ? model.trim() : "gpt-4.1-mini";
}
