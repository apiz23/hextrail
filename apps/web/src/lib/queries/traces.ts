import "server-only";

import { getServiceClient } from "@/lib/supabase/service";
import type { SessionUser } from "@/lib/auth/session";
import {
  computeOverviewStats,
  mapTraceDetail,
  mapTraceRow,
  type SpanRow,
  type TraceRow,
} from "@/lib/queries/mappers";
import type {
  ActivityPoint,
  OverviewStats,
  Page,
  ProjectSummary,
  QueryResult,
  TraceDetail,
  TraceListItem,
} from "@/lib/queries/types";

/**
 * Read queries for the dashboard.
 *
 * AUTHORIZATION MODEL
 *   Every function here takes the authenticated `SessionUser` as its first
 *   argument. That is not a convenience — it is the whole security model.
 *   RLS on the hx_ tables is default-deny with zero policies and
 *   `auth.uid()` is always NULL, so the database cannot scope a query for us.
 *   Isolation is enforced by these two rules, applied in every function:
 *
 *     1. Resolve the set of project ids owned by the session user.
 *     2. Constrain every trace/span query to that set.
 *
 *   A trace id from another user's project therefore matches zero rows and
 *   surfaces as `not_found` — not as a leak, and not as a 403 that would
 *   confirm the id exists.
 */

/** Hard cap on rows per page, regardless of what the caller asks for. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

/**
 * Clamps a requested page size into `[1, MAX_PAGE_SIZE]`.
 * Exported so the UI and tests can assert the same bound.
 */
export function clampPageSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_PAGE_SIZE;
  }
  const floored = Math.floor(requested);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_PAGE_SIZE);
}

export interface Cursor {
  /** ISO timestamp of the last row on the previous page. */
  startedAt: string;
  /** Trace id, the tiebreaker for identical timestamps. */
  id: string;
}

/** Matches the uuid column type, so a malformed id is rejected before the query. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Cursors are opaque base64url of a JSON tuple `[startedAt, id]`.
 *
 * Ordering is `(started_at DESC, id DESC)`, so the tuple is unique across the
 * result set even when two traces share a start time. That is what makes the
 * pagination stable rather than merely usually-correct.
 *
 * JSON rather than a `|`-joined string: a joined form is ambiguous if a field
 * ever contains the separator, and a mis-parsed cursor silently skips rows.
 */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(
    JSON.stringify([cursor.startedAt, cursor.id]),
    "utf8",
  ).toString("base64url");
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [startedAt, id] = parsed as [unknown, unknown];
    if (typeof startedAt !== "string" || typeof id !== "string") return null;
    if (!startedAt || !id) return null;
    if (!Number.isFinite(Date.parse(startedAt))) return null;
    return { startedAt, id };
  } catch {
    return null;
  }
}

function databaseError(message: string) {
  return { ok: false as const, error: { kind: "database" as const, message } };
}

/**
 * Project ids owned by this user.
 *
 * This is the single source of truth for isolation. Returns an empty array for
 * a user with no projects, which correctly makes every downstream query match
 * nothing.
 */
export async function ownedProjectIds(
  user: SessionUser,
): Promise<QueryResult<string[]>> {
  if (!user?.id) {
    return { ok: false, error: { kind: "unauthorized", message: "Not signed in." } };
  }

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("hx_projects")
    .select("id")
    .eq("owner_id", user.id);

  if (error) return databaseError("Could not load projects.");
  return { ok: true, data: (data ?? []).map((row: { id: string }) => row.id) };
}

/** Resolves a project the user owns, or null. Used to guard every scoped read. */
export async function ownedProject(
  user: SessionUser,
  projectId: string,
): Promise<QueryResult<{ id: string; name: string } | null>> {
  if (!user?.id) {
    return { ok: false, error: { kind: "unauthorized", message: "Not signed in." } };
  }

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("hx_projects")
    .select("id, name")
    // owner_id is the authorization predicate. Without it, any project id
    // supplied by the client would resolve.
    .eq("owner_id", user.id)
    .eq("id", projectId)
    .maybeSingle<{ id: string; name: string }>();

  if (error) return databaseError("Could not load the project.");
  return { ok: true, data: data ?? null };
}

/** All projects owned by the user, with trace counts and last activity. */
export async function listProjects(
  user: SessionUser,
): Promise<QueryResult<ProjectSummary[]>> {
  if (!user?.id) {
    return { ok: false, error: { kind: "unauthorized", message: "Not signed in." } };
  }

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("hx_projects")
    .select(
      "id, name, description, created_at, hx_traces(id, started_at)",
    )
    .eq("owner_id", user.id)
    .order("created_at", { ascending: true });

  if (error) return databaseError("Could not load projects.");

  interface ProjectRow {
    id: string;
    name: string;
    description: string | null;
    created_at: string;
    hx_traces: { started_at: string }[] | null;
  }

  const projects = (data ?? []) as unknown as ProjectRow[];

  return {
    ok: true,
    data: projects.map((project) => {
      const traces = project.hx_traces ?? [];
      const latest = traces.reduce<string | null>((newest, trace) => {
        if (!newest) return trace.started_at;
        return Date.parse(trace.started_at) > Date.parse(newest)
          ? trace.started_at
          : newest;
      }, null);

      return {
        id: project.id,
        name: project.name,
        description: project.description,
        createdAt: project.created_at,
        traceCount: traces.length,
        lastTraceAt: latest,
      };
    }),
  };
}

export interface ListTracesParams {
  projectId: string | null;
  limit?: number;
  cursor?: string;
  status?: "ok" | "error" | "running";
  /** Case-insensitive substring match against name and external trace id. */
  query?: string;
  /** Only traces started at or after this ISO timestamp. */
  since?: string;
}

/**
 * Paginated trace list, newest first.
 *
 * Ordering is `(started_at DESC, id DESC)` — a total order, so a cursor can
 * never skip or repeat a row.
 *
 * When `projectId` is null the list spans every project the user owns. When it
 * is set, ownership is still verified first: passing someone else's project id
 * yields an empty page, not their data.
 */
export async function listTraces(
  user: SessionUser,
  params: ListTracesParams,
): Promise<QueryResult<Page<TraceListItem>>> {
  if (!user?.id) {
    return { ok: false, error: { kind: "unauthorized", message: "Not signed in." } };
  }

  const limit = clampPageSize(params.limit);
  const cursor = decodeCursor(params.cursor);
  const supabase = getServiceClient();

  // --- Scope ---------------------------------------------------------------
  let scope: string[];
  if (params.projectId) {
    const owned = await ownedProject(user, params.projectId);
    if (!owned.ok) return owned;
    if (!owned.data) {
      // Not owned, or does not exist. Either way: no rows.
      return { ok: true, data: { items: [], nextCursor: null, hasMore: false } };
    }
    scope = [owned.data.id];
  } else {
    const ids = await ownedProjectIds(user);
    if (!ids.ok) return ids;
    if (ids.data.length === 0) {
      return { ok: true, data: { items: [], nextCursor: null, hasMore: false } };
    }
    scope = ids.data;
  }

  // --- Query ---------------------------------------------------------------
  // Fetch one extra row to determine `hasMore` without a second count query.
  let builder = supabase
    .from("hx_traces")
    .select(
      "id, project_id, external_trace_id, name, status, started_at, ended_at, environment, hx_projects(name), hx_spans(count)",
    )
    .in("project_id", scope)
    .order("started_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (params.status) builder = builder.eq("status", params.status);
  if (params.since) builder = builder.gte("started_at", params.since);
  if (cursor) {
    // Keyset pagination: the tuple comparison is written out because PostgREST
    // has no row-value syntax. `started_at < c` OR (`= c` AND `id < c.id`).
    builder = builder.or(
      `started_at.lt.${cursor.startedAt},and(started_at.eq.${cursor.startedAt},id.lt.${cursor.id})`,
    );
  }
  if (params.query) {
    // Comma and parenthesis are PostgREST filter metacharacters; strip them so
    // a search string cannot inject additional filter clauses.
    const needle = params.query.trim().replace(/[,()]/g, " ").slice(0, 100);
    if (needle) {
      builder = builder.or(
        `name.ilike.%${needle}%,external_trace_id.ilike.%${needle}%`,
      );
    }
  }

  const { data, error } = await builder;
  if (error) return databaseError("Could not load traces.");

  const rows = (data ?? []) as unknown as TraceRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map(mapTraceRow);

  const last = items.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeCursor({ startedAt: last.startedAt, id: last.id })
      : null;

  return { ok: true, data: { items, nextCursor, hasMore } };
}

/**
 * A single trace with its spans.
 *
 * The trace id arrives from the URL, so it is untrusted. Ownership is checked
 * via the owning project; a trace belonging to another user is reported as
 * `not_found`, deliberately indistinguishable from a trace that does not exist.
 */
export async function getTrace(
  user: SessionUser,
  traceId: string,
): Promise<QueryResult<TraceDetail>> {
  if (!user?.id) {
    return { ok: false, error: { kind: "unauthorized", message: "Not signed in." } };
  }

  // A malformed id cannot match any row. Rejecting it here keeps Postgres from
  // raising a type error that would surface as a 500 — a bad id is a client
  // error, and reporting it as a server failure would be both wrong and
  // noisy in logs.
  if (!isUuid(traceId)) {
    return { ok: false, error: { kind: "not_found", message: "Trace not found." } };
  }

  const supabase = getServiceClient();

  const { data: trace, error } = await supabase
    .from("hx_traces")
    .select(
      "id, project_id, external_trace_id, name, status, started_at, ended_at, environment, metadata, hx_projects(name, owner_id), hx_spans(count)",
    )
    .eq("id", traceId)
    .maybeSingle<TraceRow & { hx_projects: { name: string; owner_id: string } | null }>();

  if (error) return databaseError("Could not load the trace.");
  if (!trace) {
    return { ok: false, error: { kind: "not_found", message: "Trace not found." } };
  }

  // The authorization step. The trace row exists — but only the owner may see
  // it. Reported as not_found so the response cannot confirm the id exists.
  if (trace.hx_projects?.owner_id !== user.id) {
    return { ok: false, error: { kind: "not_found", message: "Trace not found." } };
  }

  const { data: spans, error: spanError } = await supabase
    .from("hx_spans")
    .select(
      "id, external_span_id, parent_external_span_id, name, kind, status, started_at, ended_at, attributes, error",
    )
    .eq("trace_id", trace.id)
    // Stable ordering for the timeline: start time, then id as tiebreaker.
    .order("started_at", { ascending: true })
    .order("id", { ascending: true });

  if (spanError) return databaseError("Could not load the trace spans.");

  return { ok: true, data: mapTraceDetail(trace, (spans ?? []) as SpanRow[]) };
}

/**
 * Overview metrics for a window.
 *
 * Deliberately capped: the metrics aggregate over at most `MAX_PAGE_SIZE * 4`
 * rows rather than unbounded history. Documented in the README as a known
 * limitation — an exact figure needs a SQL aggregate.
 */
export async function getOverviewStats(
  user: SessionUser,
  params: { projectId: string | null; since?: string },
): Promise<QueryResult<{ stats: OverviewStats; traces: TraceListItem[] }>> {
  const sample = await listTraces(user, {
    projectId: params.projectId,
    since: params.since,
    limit: MAX_PAGE_SIZE,
  });

  if (!sample.ok) return sample;

  return {
    ok: true,
    data: {
      stats: computeOverviewStats(sample.data.items),
      traces: sample.data.items,
    },
  };
}

/** Bucketed trace/error counts for the activity chart. */
export async function getActivity(
  user: SessionUser,
  params: { projectId: string | null; since: string; buckets: number },
): Promise<QueryResult<ActivityPoint[]>> {
  const result = await listTraces(user, {
    projectId: params.projectId,
    since: params.since,
    limit: MAX_PAGE_SIZE,
  });

  if (!result.ok) return result;

  const windowMs = Date.now() - Date.parse(params.since);
  const bucketMs = Math.max(Math.floor(windowMs / params.buckets), 1);

  const points: ActivityPoint[] = Array.from(
    { length: params.buckets },
    (_, index) => ({
      label: new Date(
        Date.parse(params.since) + index * bucketMs,
      ).toISOString(),
      traces: 0,
      errors: 0,
    }),
  );

  for (const trace of result.data.items) {
    const offset = Date.parse(trace.startedAt) - Date.parse(params.since);
    const index = Math.min(
      Math.max(Math.floor(offset / bucketMs), 0),
      points.length - 1,
    );
    points[index].traces += 1;
    if (trace.status === "error") points[index].errors += 1;
  }

  return { ok: true, data: points };
}
