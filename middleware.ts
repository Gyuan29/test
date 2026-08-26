import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionCookie } from "@/lib/auth";

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (pathname === "/login" || pathname === "/register" || pathname === "/api/auth/login" || pathname === "/api/auth/register" || pathname === "/api/auth/logout" || pathname.startsWith("/_next/") || pathname.startsWith("/favicon")) return NextResponse.next();
  const value = request.cookies.get(SESSION_COOKIE)?.value;
  const token = await verifySessionCookie(value);
  if (token) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const url = request.nextUrl.clone(); url.pathname = "/login"; url.search = ""; return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!.*\\.[^/]+$).*)"] };
