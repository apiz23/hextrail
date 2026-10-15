import { NextResponse, type NextRequest } from "next/server";

import { getSession } from "@/lib/auth/session";
import { getTrace } from "@/lib/queries/traces";

/**
 * Trace detail for the dashboard.
 *
 * Separate from `POST /api/v1/traces`, which is the SDK ingestion surface and
 * authenticates with a bearer API key. This route is session-authenticated and
 * read-only.
 *
 * The trace id comes from the URL and is therefore untrusted. `getTrace`
 * resolves the owning project and requires the session user to be its owner;
 * a trace owned by someone else returns 404, not 403. That is deliberate —
 * a 403 would confirm the id exists.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ traceId: string }> },
) {
  const session = await getSession();

  if (!session) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Sign in to view traces." } },
      { status: 401 },
    );
  }

  const { traceId } = await params;
  // Validation lives in `getTrace`, which owns the "is this a usable id"
  // decision — including the uuid shape check.
  const result = await getTrace(session.user, traceId);

  if (!result.ok) {
    switch (result.error.kind) {
      case "unauthorized":
        return NextResponse.json(
          { error: { code: "unauthorized", message: result.error.message } },
          { status: 401 },
        );
      case "not_found":
        return NextResponse.json(
          { error: { code: "not_found", message: result.error.message } },
          { status: 404 },
        );
      default:
        return NextResponse.json(
          { error: { code: "internal_error", message: result.error.message } },
          { status: 500 },
        );
    }
  }

  return NextResponse.json(
    { trace: result.data },
    { headers: { "Cache-Control": "no-store" } },
  );
}
