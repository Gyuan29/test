export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function formatDate(value: string | null | undefined, withTime = true): string {
  if (!value || /^(unknown|null|undefined|nan|invalid)$/i.test(value.trim())) return "近期";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "近期";
  const pad = (part: number) => String(part).padStart(2, "0");
  const date = `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
  if (!withTime) return date;
  return `${date} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}
