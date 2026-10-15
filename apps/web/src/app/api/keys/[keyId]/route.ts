import { NextResponse, type NextRequest } from "next/server";

import { getSession } from "@/lib/auth/session";
import { revokeApiKey } from "@/lib/api-keys/keys";
import type { QueryError } from "@/lib/queries/types";

/** Matches the uuid column type so a malformed id cannot reach Postgres. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResponse(error: QueryError) {
  switch (error.kind) {
    case "unauthorized":
      return NextResponse.json(
        { error: { code: "unauthorized", message: error.message } },
        { status: 401 },
      );
    case "not_found":
      return NextResponse.json(
        { error: { code: "not_found", message: error.message } },
        { status: 404 },
      );
    default:
      return NextResponse.json(
        { error: { code: "internal_error", message: "Something went wrong." } },
        { status: 500 },
      );
  }
}

/**
 * Revokes a key.
 *
 * A key belonging to another user's project returns 404 rather than 403. A
 * 403 would confirm that the id exists, which is the signal an attacker
 * probing ids is looking for.
 *
 * Idempotent: revoking an already-revoked key succeeds both times.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ keyId: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Sign in to manage API keys." } },
      { status: 401 },
    );
  }

  const { keyId } = await params;

  // A malformed id cannot match a row. Rejecting it here keeps Postgres from
  // raising a uuid type error that would surface as a misleading 500.
  if (!UUID_PATTERN.test(keyId)) {
    return NextResponse.json(
      { error: { code: "not_found", message: "API key not found." } },
      { status: 404 },
    );
  }

  const result = await revokeApiKey(session.user, keyId);
  if (!result.ok) return errorResponse(result.error);

  return NextResponse.json(
    { id: result.data.id, revokedAt: result.data.revokedAt },
    { headers: { "Cache-Control": "no-store" } },
  );
}
