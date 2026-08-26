import { normalizeEventDate, normalizeEventDescription, normalizeEventTitle } from "./event-display.js";
import { normalizeOfficialDomain } from "./official-domain.js";

function isStructured(value) {
  return typeof value === "string" && value.trim().startsWith("{");
}

export function contentUpdates(row) {
  const updates = {
    website_url: row.website_url && !normalizeOfficialDomain(row.website_url) ? null : undefined,
    title: undefined,
    summary: undefined,
    translated_title: undefined,
    translated_description: undefined,
    event_date: normalizeEventDate(row.event_date) ?? "unknown",
  };

  if (isStructured(row.title)) {
    const title = normalizeEventTitle(row.title);
    if (title !== row.title) updates.title = title;
  }
  if (isStructured(row.translated_title)) {
    const title = normalizeEventTitle(row.translated_title, normalizeEventTitle(row.title));
    if (title !== row.translated_title) updates.translated_title = title;
  }
  if (isStructured(row.summary)) {
    const summary = normalizeEventDescription(row.summary);
    if (summary !== row.summary) updates.summary = summary;
  }
  if (isStructured(row.translated_description)) {
    const description = normalizeEventDescription(row.translated_description, row.summary || normalizeEventTitle(row.title));
    if (description !== row.translated_description) updates.translated_description = description;
  }
  if (updates.event_date === row.event_date) updates.event_date = undefined;
  return updates;
}
