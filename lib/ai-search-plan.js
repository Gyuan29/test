export function extractAiSearchContent(content) {
  if (!Array.isArray(content) || content.length !== 1) return "";
  const part = content[0];
  return part && part.type === "text" && typeof part.text === "string" ? part.text : "";
}
