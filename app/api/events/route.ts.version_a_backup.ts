import { NextRequest, NextResponse } from "next/server";
import { getDatabase } from "@/lib/db";

export const dynamic = "force-dynamic";

function categoryFor(value: string): "news" | "announcement" | "research" | "other" {
  const normalized = value.toLowerCase();
  if (/(news|新闻|动态|media)/u.test(normalized)) return "news";
  if (/(announcement|公告|通知|发布|声明)/u.test(normalized)) return "announcement";
  if (/(research|研究|论文|报告|科研)/u.test(normalized)) return "research";
  return "other";
}

export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const page = Math.max(1, Number(params.get("page") || 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(params.get("limit") || 20) || 20));
  const search = params.get("search")?.trim() || "";
  const category = params.get("category")?.trim() || "";
  try {
    const db = await getDatabase();
    if (!db) return NextResponse.json({ success: false, error: "Database is not configured" }, { status: 503 });
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (search) { clauses.push("(e.title LIKE ? OR e.summary LIKE ? OR e.translated_title LIKE ? OR e.translated_description LIKE ? OR o.name LIKE ?)"); values.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
    if (category) {
      const patterns: Record<string, string[]> = {
        news: ["%news%", "%新闻%", "%动态%", "%media%"],
        announcement: ["%announcement%", "%公告%", "%通知%", "%发布%", "%声明%"],
        research: ["%research%", "%研究%", "%论文%", "%报告%", "%科研%"],
      };
      const matches = patterns[category.toLowerCase()] ?? [`%${category.toLowerCase()}%`];
      clauses.push(`(${matches.map(() => "lower(coalesce(e.event_type, '')) LIKE ?").join(" OR ")})`);
      values.push(...matches);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const count = await db.prepare(`SELECT COUNT(*) AS value FROM events e JOIN organizations o ON o.entity_id=e.organization_id ${where}`).bind(...values).first<{ value: number }>();
    const rows = await db.prepare(`SELECT e.id, e.organization_id AS organizationId, o.name AS organizationName, o.slug AS organizationSlug, e.title, e.summary, e.translated_title AS translatedTitle, e.translated_description AS translatedDescription, e.event_date AS eventDate, e.event_type AS eventType, e.source_url AS sourceUrl, e.source_name AS sourceName FROM events e JOIN organizations o ON o.entity_id=e.organization_id ${where} ORDER BY e.event_date DESC, e.created_at DESC LIMIT ? OFFSET ?`).bind(...values, limit, (page - 1) * limit).all<Record<string, unknown>>();
    const total = Number(count?.value ?? 0);
    return NextResponse.json({ success: true, data: rows.results.map((row) => ({ id: String(row.id), organizationId: String(row.organizationId), organizationName: String(row.organizationName), organizationSlug: String(row.organizationSlug), title: String(row.translatedTitle || row.title), description: String(row.translatedDescription || row.summary || row.title), eventDate: row.eventDate == null ? null : String(row.eventDate), category: categoryFor(String(row.eventType || "")), sourceUrl: row.sourceUrl == null ? null : String(row.sourceUrl), sourceName: row.sourceName == null ? null : String(row.sourceName) })), pagination: { page, limit, total, totalPages: total ? Math.ceil(total / limit) : 0 } });
  } catch (error) {
    console.error("Failed to fetch events", error);
    return NextResponse.json({ success: false, error: "Failed to fetch events" }, { status: 500 });
  }
}
