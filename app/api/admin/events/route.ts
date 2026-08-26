import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { events, organizations } from "@/db/schema";
import { getAdminDatabase } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

const publicEventFields = { id: events.id, organizationId: events.organizationId, eventDate: events.eventDate, eventType: events.eventType, title: events.title, summary: events.summary, sourceUrl: events.sourceUrl, sourceName: events.sourceName, createdAt: events.createdAt };
function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value.trim() : fallback; }
function payload(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

export async function GET(request: NextRequest) {
  const denied = await requireAdmin(request); if (denied) return denied;
  try {
    const db = await getAdminDatabase();
    const rows = await db.select({ ...publicEventFields, organizationName: organizations.name }).from(events).leftJoin(organizations, eq(events.organizationId, organizations.entityId)).orderBy(desc(events.eventDate)).all();
    return NextResponse.json({ success: true, data: rows });
  } catch (error) {
    console.error("Failed to list admin events", error);
    return NextResponse.json({ success: false, error: "Unable to list events" }, { status: 500 });
  }
}

function eventValues(body: Record<string, unknown>) {
  return { organizationId: text(body.organizationId), eventDate: text(body.eventDate, new Date().toISOString()), eventType: text(body.eventType, "other") || null, title: text(body.title), summary: text(body.summary) || null, sourceUrl: text(body.sourceUrl) || null, sourceName: text(body.sourceName) || null };
}

export async function POST(request: NextRequest) {
  const denied = await requireAdmin(request); if (denied) return denied;
  const values = eventValues(payload(await request.json().catch(() => null)));
  if (!values.organizationId || !values.title) return NextResponse.json({ success: false, error: "organizationId and title are required" }, { status: 400 });
  try {
    const db = await getAdminDatabase();
    const id = `event_${randomUUID()}`;
    await db.insert(events).values({ id, ...values }).run();
    const created = await db.select(publicEventFields).from(events).where(eq(events.id, id)).get();
    return NextResponse.json({ success: true, data: created }, { status: 201 });
  } catch (error) {
    console.error("Failed to create event", error);
    return NextResponse.json({ success: false, error: "Unable to create event" }, { status: 409 });
  }
}

export async function PUT(request: NextRequest) {
  const denied = await requireAdmin(request); if (denied) return denied;
  const body = payload(await request.json().catch(() => null));
  const id = text(body.id);
  const values = eventValues(body);
  if (!id || !values.organizationId || !values.title) return NextResponse.json({ success: false, error: "id, organizationId and title are required" }, { status: 400 });
  try {
    const db = await getAdminDatabase();
    await db.update(events).set(values).where(eq(events.id, id)).run();
    const updated = await db.select(publicEventFields).from(events).where(eq(events.id, id)).get();
    if (!updated) return NextResponse.json({ success: false, error: "Event not found" }, { status: 404 });
    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    console.error("Failed to update event", error);
    return NextResponse.json({ success: false, error: "Unable to update event" }, { status: 409 });
  }
}

export async function DELETE(request: NextRequest) {
  const denied = await requireAdmin(request); if (denied) return denied;
  const body = payload(await request.json().catch(() => null));
  const id = text(body.id) || new URL(request.url).searchParams.get("id")?.trim() || "";
  if (!id) return NextResponse.json({ success: false, error: "id is required" }, { status: 400 });
  try {
    const db = await getAdminDatabase();
    await db.delete(events).where(eq(events.id, id)).run();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete event", error);
    return NextResponse.json({ success: false, error: "Unable to delete event" }, { status: 500 });
  }
}
