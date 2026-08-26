const SEARCH_COLUMNS = ["name", "description", "summary", "context"];

function toSearchPattern(value) {
  return `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

export function buildOrganizationSearch(value) {
  const search = value.trim();
  if (!search) return { whereClause: "", values: [] };

  const pattern = toSearchPattern(search);
  return {
    whereClause: `WHERE ${SEARCH_COLUMNS.map((column) => `${column} LIKE ? ESCAPE '\\'`).join("\n          OR ")}`,
    values: SEARCH_COLUMNS.map(() => pattern),
  };
}
