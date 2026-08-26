import { NextResponse } from "next/server";
import { getAdminRole } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const role = await getAdminRole(request);
  return NextResponse.json({ valid: Boolean(role), role }, { status: role ? 200 : 403 });
}
