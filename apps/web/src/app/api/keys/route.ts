import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth/session";
import { createApiKey, listApiKeys } from "@/lib/api-keys/keys";
import type { QueryError } from "@/lib/queries/types";

/**
 * API key collection.
 *
 * Session-authenticated. Distinct from `POST /api/v1/traces`, which is the SDK
 * ingestion surface and authenticates with a bearer key.
 */

/** Maps a query-layer error onto an HTTP response. */
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
      // The database message is not echoed back, so a failure cannot leak
      // schema or constraint details to the client.
      return NextResponse.json(
        { error: { code: "internal_error", message: "Something went wrong." } },
        { status: 500 },
      );
  }
}

/**
 * Matches the uuid column type by shape, rather than Zod's `uuid()` which
 * additionally enforces an RFC 4122 version nibble and variant. Postgres
 * accepts any well-formed uuid, so a stricter check here would reject ids the
 * database considers valid. This is the same pattern the rest of the codebase
 * uses for uuid inputs.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createSchema = z.object({
  projectId: z.string().regex(UUID_PATTERN, "Expected a uuid."),
  name: z.string().trim().min(1).max(100),
});

/** Lists the user's keys — prefix and metadata only, never a hash. */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Sign in to manage API keys." } },
      { status: 401 },
    );
  }

  const result = await listApiKeys(session.user);
  if (!result.ok) return errorResponse(result.error);

  return NextResponse.json(
    { keys: result.data },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Creates a key.
 *
 * The response contains the raw key and is marked `no-store` so no proxy,
 * CDN, or browser cache retains it. This is the only response in the
 * application that carries key material.
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Sign in to manage API keys." } },
      { status: 401 },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_json", message: "Request body must be JSON." } },
      { status: 400 },
    );
  }

  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_payload",
          message: "A project and a key name (1-100 characters) are required.",
        },
      },
      { status: 400 },
    );
  }

  const result = await createApiKey(session.user, parsed.data);
  if (!result.ok) return errorResponse(result.error);

  return NextResponse.json(
    { key: result.data.key, rawKey: result.data.rawKey },
    {
      status: 201,
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
      },
    },
  );
}
