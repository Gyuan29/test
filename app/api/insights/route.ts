import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getAuthDatabase, getDatabase } from "@/lib/db";
import { normalizeEventDate, normalizeEventDescription, normalizeEventTitle } from "@/lib/event-display";

export const dynamic = "force-dynamic";

type EventRow = { id: string; organization_id: string; organization_name: string; organization_slug: string; website_url: string | null; title: string; summary: string | null; translated_title: string | null; translated_description: string | null; event_date: string | null; event_type: string | null; source_url: string | null; source_name: string | null };
export type InsightEvent = { id: string; organizationId: string; organizationName: string; organizationSlug: string; description: string; eventDate: string | null; category: "news" | "announcement" | "research" | "other"; sourceUrl: string | null; sourceName: string | null };
const INSIGHT_EVENT_SAMPLE_LIMIT = 500;

function categoryFor(value: string | null): InsightEvent["category"] {
  const normalized = (value ?? "").toLowerCase();
  if (/(news|鏂伴椈|鍔ㄦ€亅media)/u.test(normalized)) return "news";
  if (/(announcement|鍏憡|閫氱煡|鍙戝竷|澹版槑)/u.test(normalized)) return "announcement";
  if (/(research|鐮旂┒|璁烘枃|鎶ュ憡|绉戠爺)/u.test(normalized)) return "research";
  return "other";
}
function hostname(value: string | null): string | null { if (!value) return null; try { return new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./u, ""); } catch { return null; } }
function isOfficial(sourceUrl: string | null, websiteUrl: string | null): boolean { const source = hostname(sourceUrl); const official = hostname(websiteUrl); return Boolean(source && official && (source === official || source.endsWith(`.${official}`) || official.endsWith(`.${source}`))); }
function domainSuffix(value: string | null): string | null { const host = hostname(value); if (!host) return null; const parts = host.split("."); if (parts.length < 2) return `.${host}`; const secondLast = parts.at(-2) ?? ""; return ["com", "org", "net", "edu", "gov", "ac", "co"].includes(secondLast) && parts.length >= 3 ? `.${parts.slice(-3).join(".")}` : `.${parts.slice(-2).join(".")}`; }
function mapEvent(row: EventRow): InsightEvent { const title = normalizeEventTitle(row.title); return { id: row.id, organizationId: row.organization_id, organizationName: row.organization_name, organizationSlug: row.organization_slug, description: normalizeEventDescription(row.translated_description ?? row.summary ?? row.translated_title, row.summary?.trim() || title), eventDate: normalizeEventDate(row.event_date), category: categoryFor(row.event_type), sourceUrl: row.source_url, sourceName: row.source_name }; }

export async function GET(request: Request) {
  try {
    const db = await getDatabase();
    if (!db) return NextResponse.json({ success: false, error: "Database is not configured" }, { status: 503 });
    const authDb = await getAuthDatabase();
    if (!authDb || !(await currentUser(request, authDb))) return NextResponse.json({ success: false, error: "authentication_required" }, { status: 401 });
    const [organizationCount, eventCount, eventResult, organizationResult] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS value FROM organizations").first<{ value: number }>(),
      db.prepare("SELECT COUNT(*) AS value FROM events").first<{ value: number }>(),
      db.prepare(`SELECT e.id, e.organization_id, o.name AS organization_name, o.slug AS organization_slug, o.website_url, e.title, e.summary, e.translated_title, e.translated_description, e.event_date, e.event_type, e.source_url, e.source_name FROM events e JOIN organizations o ON o.entity_id = e.organization_id ORDER BY CASE WHEN e.event_date IS NULL OR e.event_date = '' THEN 1 ELSE 0 END, e.event_date DESC, e.created_at DESC LIMIT ${INSIGHT_EVENT_SAMPLE_LIMIT}`).all<EventRow>(),
      db.prepare("SELECT website_url FROM organizations WHERE website_url IS NOT NULL AND trim(website_url) <> ''").all<{ website_url: string }>(),
    ]);
    const events = eventResult.results.map(mapEvent);
    const categories: Record<InsightEvent["category"], InsightEvent[]> = { news: [], announcement: [], research: [], other: [] };
    for (const event of events) if (categories[event.category].length < 10) categories[event.category].push(event);
    const activeWatchEvents = events.filter((event, index) => isOfficial(event.sourceUrl, eventResult.results[index].website_url)).slice(0, 10);
    const passiveWatchEvents = events.filter((event, index) => Boolean(event.sourceUrl) && !isOfficial(event.sourceUrl, eventResult.results[index].website_url)).slice(0, 10);
    const domainCounts = new Map<string, number>();
    for (const row of organizationResult.results) { const suffix = domainSuffix(row.website_url); if (suffix) domainCounts.set(suffix, (domainCounts.get(suffix) ?? 0) + 1); }
    return NextResponse.json({ success: true, data: { totalOrganizations: Number(organizationCount?.value ?? 0), totalEvents: Number(eventCount?.value ?? 0), recentEvents: events.slice(0, 20), eventsByCategory: categories, activeWatchEvents, passiveWatchEvents, domainStats: [...domainCounts.entries()].map(([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count) } });
  } catch (error) {
    console.error("Failed to fetch insight statistics", error);
    return NextResponse.json({ success: false, error: "Failed to fetch insight statistics" }, { status: 500 });
  }
}
