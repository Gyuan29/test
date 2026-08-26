import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { organizations } from "@/db/schema";
import { getAdminDatabase } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

const publicOrganizationFields = {
  entityId: organizations.entityId,
  slug: organizations.slug,
  name: organizations.name,
  description: organizations.description,
  entityType: organizations.entityType,
  region: organizations.region,
  country: organizations.country,
  websiteUrl: organizations.websiteUrl,
  lastSearchedAt: organizations.lastSearchedAt,
  searchStatus: organizations.searchStatus,
  lastEventSearchedAt: organizations.lastEventSearchedAt,
  eventSearchStatus: organizations.eventSearchStatus,
  createdAt: organizations.createdAt,
  updatedAt: organizations.updatedAt,
};

function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value.trim() : fallback; }
function slugify(name: string, suffix: string): string { return `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "organization"}-${suffix.slice(0, 8)}`; }
function payload(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

export async function GET(request: NextRequest) {
  const denied = await requireAdmin(request); if (denied) return denied;
  try {
    const db = await getAdminDatabase();
    const rows = await db.select(publicOrganizationFields).from(organizations).orderBy(asc(organizations.name)).all();
    return NextResponse.json({ success: true, data: rows });
  } catch (error) {
    console.error("Failed to list admin organizations", error);
    return NextResponse.json({ success: false, error: "Unable to list organizations" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const denied = await requireAdmin(request); if (denied) return denied;
  const body = payload(await request.json().catch(() => null));
  const name = text(body.name);
  if (!name) return NextResponse.json({ success: false, error: "name is required" }, { status: 400 });
  const entityId = text(body.entityId) || `org_${randomUUID()}`;
  const slug = text(body.slug) || slugify(name, entityId);
  try {
    const db = await getAdminDatabase();
    await db.insert(organizations).values({ entityId, slug, name, description: text(body.description) || null, websiteUrl: text(body.websiteUrl) || null, entityType: text(body.entityType, "institution"), region: text(body.region, "未分类"), country: text(body.country, "未分类"), eventSearchStatus: "pending", lastEventSearchedAt: null, updatedAt: new Date().toISOString() }).run();
    const created = await db.select(publicOrganizationFields).from(organizations).where(eq(organizations.entityId, entityId)).get();
    return NextResponse.json({ success: true, data: created }, { status: 201 });
  } catch (error) {
    console.error("Failed to create organization", error);
    return NextResponse.json({ success: false, error: "Unable to create organization" }, { status: 409 });
  }
}

export async function PUT(request: NextRequest) {
  const denied = await requireAdmin(request); if (denied) return denied;
  const body = payload(await request.json().catch(() => null));
  const entityId = text(body.entityId);
  const name = text(body.name);
  if (!entityId || !name) return NextResponse.json({ success: false, error: "entityId and name are required" }, { status: 400 });
  try {
    const db = await getAdminDatabase();
    await db.update(organizations).set({ description: text(body.description) || null, updatedAt: new Date().toISOString() }).where(eq(organizations.entityId, entityId)).run();
    const updated = await db.select(publicOrganizationFields).from(organizations).where(eq(organizations.entityId, entityId)).get();
    if (!updated) return NextResponse.json({ success: false, error: "Organization not found" }, { status: 404 });
    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    console.error("Failed to update organization", error);
    return NextResponse.json({ success: false, error: "Unable to update organization" }, { status: 409 });
  }
}

export async function DELETE(request: NextRequest) {
  const denied = await requireAdmin(request); if (denied) return denied;
  const body = payload(await request.json().catch(() => null));
  const entityId = text(body.entityId) || new URL(request.url).searchParams.get("entityId")?.trim() || "";
  if (!entityId) return NextResponse.json({ success: false, error: "entityId is required" }, { status: 400 });
  try {
    const db = await getAdminDatabase();
    await db.delete(organizations).where(eq(organizations.entityId, entityId)).run();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete organization", error);
    return NextResponse.json({ success: false, error: "Unable to delete organization" }, { status: 500 });
  }
}
