import { currentUser } from "@/lib/auth";
import { getAuthDatabase, getDatabase, json, mapEvent, mapOrganization, type EventRow, type OrganizationRow } from "@/lib/db";

type SourceHealth = {
  id: string;
  name: string;
  url: string;
  last_fetch_status: string | null;
  last_checked_at: string | null;
  next_check_at: string | null;
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  const { slug } = await context.params;
  const db = await getDatabase();
  if (!db) return json({ error: "database_unconfigured" }, { status: 503 });
  const authDb = await getAuthDatabase();
  if (!authDb || !(await currentUser(_request, authDb))) return json({ error: "authentication_required" }, { status: 401 });

  const organization = await db
    .prepare("SELECT * FROM organizations WHERE slug = ? LIMIT 1")
    .bind(slug)
    .first<OrganizationRow>();
  if (!organization) return json({ error: "organization_not_found" }, { status: 404 });
  const organizationRecord = mapOrganization(organization);

  const [eventResult, sourceResult] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM events
         WHERE organization_id = ?
         ORDER BY event_date DESC LIMIT 100`,
      )
      .bind(organizationRecord.entityId)
      .all<EventRow>(),
    // news_sources is maintained by the collector. A freshly created database
    // may not have that optional table yet, so profile rendering remains valid.
    db
      .prepare(
        `SELECT id, name, url, last_fetch_status, last_checked_at, next_check_at
         FROM news_sources WHERE organization_slug = ? ORDER BY name ASC`,
      )
      .bind(organizationRecord.slug)
      .all<SourceHealth>()
      .catch(() => ({ results: [] as SourceHealth[] })),
  ]);

  return json({ organization: organizationRecord, events: eventResult.results.map(mapEvent), newsSources: sourceResult.results });
}
