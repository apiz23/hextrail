import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE, signOut } from "@/lib/auth/session";

/**
 * Sign-out endpoint.
 *
 * Revokes the session row (so the token is dead server-side even if the cookie
 * is replayed) and clears the cookie. Revoking first means a leak of the old
 * cookie value is useless after sign-out.
 */
export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;

  try {
    if (token) await signOut(token);
  } catch {
    // A failed revoke must not leave the cookie in place: clearing it is still
    // the safer outcome for the user.
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}
