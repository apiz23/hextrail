import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { SESSION_COOKIE, signIn } from "@/lib/auth/session";

/**
 * Sign-in endpoint.
 *
 * Sets the session token as an httpOnly cookie. The raw token is never
 * returned in the body, so it cannot be read by client JavaScript even if a
 * caller logs the response.
 */

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_json", message: "Request body must be JSON." } },
      { status: 400 },
    );
  }

  const parsed = loginSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_payload", message: "Email and password are required." } },
      { status: 400 },
    );
  }

  let result: Awaited<ReturnType<typeof signIn>>;
  try {
    result = await signIn(parsed.data.email, parsed.data.password);
  } catch {
    return NextResponse.json(
      { error: { code: "internal_error", message: "Sign-in is temporarily unavailable." } },
      { status: 500 },
    );
  }

  if (!result.ok || !result.token || !result.expiresAt) {
    // One message for every failure mode — never reveal whether the email
    // exists.
    return NextResponse.json(
      {
        error: {
          code: "invalid_credentials",
          message: "Email or password is incorrect.",
        },
      },
      { status: 401 },
    );
  }

  const response = NextResponse.json({
    user: {
      id: result.user!.id,
      email: result.user!.email,
      displayName: result.user!.displayName,
    },
  });

  response.cookies.set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: result.expiresAt,
  });

  return response;
}
