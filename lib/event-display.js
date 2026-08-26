function parseStructuredText(value) {
  if (typeof value !== "string" || !value.trim().startsWith("{")) return null;
  const text = value.trim();
  for (let index = 1, depth = 0, inString = false, escaped = false; index <= text.length; index += 1) {
    const character = text[index - 1];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(0, index));
          return parsed && typeof parsed === "object" ? parsed : null;
        } catch {
          break;
        }
      }
    }
  }

  const partial = {};
  for (const field of ["title", "description"]) {
    const match = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`, "su").exec(text);
    if (!match) continue;
    try {
      partial[field] = JSON.parse(`"${match[1]}"`);
    } catch {
      partial[field] = match[1];
    }
  }
  return Object.keys(partial).length ? partial : null;
}

function normalizeText(value, fallback, field) {
  const text = typeof value === "string" ? value.trim() : "";
  const structured = parseStructuredText(text);
  if (structured) {
    const nested = structured[field];
    return typeof nested === "string" && nested.trim() ? nested.trim() : fallback;
  }
  return text || fallback;
}

export function normalizeEventTitle(value, fallback = "未命名事件") {
  return normalizeText(value, fallback, "title");
}

export function normalizeEventDescription(value, fallback = "暂无摘要") {
  return normalizeText(value, fallback, "description");
}

export function normalizeEventDate(value) {
  if (typeof value !== "string") return null;
  const date = value.trim();
  if (!date || date.toLowerCase() === "unknown") return null;
  const yearMatch = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/u.exec(date);
  if (!yearMatch || Number(yearMatch[1]) < 1000 || Number.isNaN(Date.parse(date))) return null;
  return date;
}
