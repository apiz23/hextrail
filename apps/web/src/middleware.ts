import { NextResponse, type NextRequest } from "next/server";

// Import from the dependency-free module on purpose: middleware runs on the
// edge runtime and must not pull in Node crypto or the Supabase client.
import { SESSION_COOKIE } from "@/lib/auth/cookie";

/**
 * Route protection.
 *
 * This is a COOKIE-PRESENCE check only — middleware runs on the edge runtime
 * and cannot reach the database, so it cannot validate the session. It exists
 * to avoid rendering an authenticated shell for a visitor with no cookie at
 * all, and to bounce them to the login page with a `next` target.
 *
 * The real authorization happens server-side in every page and query, which
 * calls `getSession()` and scopes all reads by ownership. If this middleware
 * were removed, the pages would still refuse to leak data — they would just
 * render the signed-out state instead of redirecting.
 */

const PUBLIC_PATHS = ["/login"];

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (PUBLIC_PATHS.some((path) => pathname.startsWith(path))) {
    return NextResponse.next();
  }

  const hasCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  if (hasCookie) return NextResponse.next();

  const loginUrl = new URL("/login", request.url);
  // Preserve the destination so sign-in returns the user where they intended.
  loginUrl.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    /*
     * Everything except:
     *   - /api/*        (routes do their own auth and must return JSON, not HTML)
     *   - /_next/*      (build assets)
     *   - /login        (the sign-in page itself)
     *   - static files with an extension
     */
    "/((?!api|_next/static|_next/image|login|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
