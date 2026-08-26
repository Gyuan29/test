import { NextRequest, NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { getDatabase, mapOrganization, type OrganizationRow } from "@/lib/db";
import { buildOrganizationSearch } from "@/lib/organization-search";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_PAGE = 1;

function getLimit(value: string | null): number | null {
  if (value === null) {
    return DEFAULT_LIMIT;
  }

  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return null;
  }

  return limit;
}

function getPage(value: string | null): number | null {
  if (value === null) {
    return DEFAULT_PAGE;
  }

  const page = Number(value);
  if (!Number.isInteger(page) || page < 1) {
    return null;
  }

  return page;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search")?.trim();
  const page = getPage(searchParams.get("page"));
  const limit = getLimit(searchParams.get("limit"));

  if (page === null) {
    return NextResponse.json(
      { success: false, error: "page must be a positive integer" },
      { status: 400 },
    );
  }

  if (limit === null) {
    return NextResponse.json(
      { success: false, error: `limit must be an integer between 1 and ${MAX_LIMIT}` },
      { status: 400 },
    );
  }

  try {
    const db = await getDatabase();
    if (!db) {
      return NextResponse.json(
        { success: false, error: "Database is not configured" },
        { status: 503 },
      );
    }
    if (!(await currentUser(request, db))) return NextResponse.json({ success: false, error: "authentication_required" }, { status: 401 });

    const { whereClause, values: searchValues } = buildOrganizationSearch(search ?? "");
    const core = searchParams.get("core")?.toLowerCase();
    const coreClause = core === "true" || core === "1" ? "is_core_tracking = 1" : core === "false" || core === "0" ? "is_core_tracking = 0" : "";
    const combinedWhere = [whereClause.replace(/^WHERE\s+/i, ""), coreClause].filter(Boolean).join(" AND ");
    const finalWhere = combinedWhere ? `WHERE ${combinedWhere}` : "";
    const statement = db.prepare(
      `SELECT * FROM organizations
       ${finalWhere}
       ORDER BY name ASC LIMIT ? OFFSET ?`,
    );
    const countResult = await db
      .prepare(`SELECT COUNT(*) AS count FROM organizations ${finalWhere}`)
      .bind(...searchValues)
      .first<{ count: number }>();
    const total = Number(countResult?.count ?? 0);
    const offset = (page - 1) * limit;
    const result = await statement
      .bind(...(searchValues.length ? [...searchValues, limit, offset] : [limit, offset]))
      .all<OrganizationRow>();

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    return NextResponse.json({
      success: true,
      data: result.results.map(mapOrganization),
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: totalPages > 0 && page < totalPages,
        hasPreviousPage: page > 1 && totalPages > 0,
      },
    });
  } catch (error) {
    console.error("Failed to fetch organizations", error);

    return NextResponse.json(
      { success: false, error: "Failed to fetch organizations" },
      { status: 500 },
    );
  }
}
