import "server-only";

import { getSession, type Session } from "@/lib/auth/session";
import {
  firstValue,
  parseProjectId,
  parseQuery,
  parseRange,
  parseStatus,
  rangeSince,
} from "@/lib/queries/page-params";
import {
  getTrace,
  listProjects,
  listTraces,
  ownedProject,
  type ListTracesParams,
} from "@/lib/queries/traces";
import type {
  ProjectSummary,
  QueryError,
  TraceDetail,
  TraceListItem,
} from "@/lib/queries/types";
import type { TimeRangeKey } from "@/lib/data/time-ranges";

/**
 * Shared data loading for the dashboard routes.
 *
 * Every route funnels through `loadDashboardData`, so there is exactly one
 * place where a session is resolved and one place where a project scope is
 * authorized. A new page cannot accidentally skip the ownership check.
 */

export interface DashboardSearchParams {
  [key: string]: string | string[] | undefined;
}

export interface DashboardContext {
  session: Session;
  projects: ProjectSummary[];
  /** Authorized project id, or null for "all owned projects". */
  projectId: string | null;
  range: TimeRangeKey;
}

export type DashboardLoad =
  | { ok: true; context: DashboardContext }
  | { ok: false; reason: "unauthorized" | "database"; message: string };

/**
 * Resolves the session, the user's projects, and the authorized project scope.
 *
 * A `?project=` id the user does not own is *dropped*, not rejected: the page
 * falls back to "all projects" rather than erroring, and no query is ever
 * issued with the unowned id.
 */
export async function loadDashboardContext(
  searchParams: DashboardSearchParams,
): Promise<DashboardLoad> {
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      reason: "unauthorized",
      message: "Sign in to view the dashboard.",
    };
  }

  const projectResult = await listProjects(session.user);
  if (!projectResult.ok) {
    return {
      ok: false,
      reason: "database",
      message: projectResult.error.message,
    };
  }

  const requested = parseProjectId(firstValue(searchParams.project));

  // authorize: the id must belong to the session user.
  let projectId: string | null = null;
  if (requested) {
    const owned = await ownedProject(session.user, requested);
    if (!owned.ok) {
      return { ok: false, reason: "database", message: owned.error.message };
    }
    projectId = owned.data?.id ?? null;
  }

  return {
    ok: true,
    context: {
      session,
      projects: projectResult.data,
      projectId,
      range: parseRange(firstValue(searchParams.range)),
    },
  };
}

export interface TraceListData {
  traces: TraceListItem[];
  shown: number;
  total: number | null;
  nextCursor: string | null;
  hasMore: boolean;
  error: QueryError | null;
}

/**
 * Trace list for the explorer.
 *
 * `params` is built from the URL, then handed to `listTraces`, which applies
 * the ownership scope. A database failure is returned as data (`error`) rather
 * than thrown, so the page can render an error state with a retry instead of
 * blowing up the route.
 */
export async function loadTraceList(
  context: DashboardContext,
  searchParams: DashboardSearchParams,
): Promise<TraceListData> {
  const params: ListTracesParams = {
    projectId: context.projectId,
    limit: Number(firstValue(searchParams.limit) ?? "") || undefined,
    cursor: firstValue(searchParams.cursor),
    status: parseStatus(firstValue(searchParams.status)),
    query: parseQuery(firstValue(searchParams.q)),
    since: rangeSince(context.range),
  };

  const result = await listTraces(context.session.user, params);

  if (!result.ok) {
    return {
      traces: [],
      shown: 0,
      total: null,
      nextCursor: null,
      hasMore: false,
      error: result.error,
    };
  }

  return {
    traces: result.data.items,
    shown: result.data.items.length,
    // An exact total would need a second count query; the "Load more" button
    // already communicates that more rows exist, so no figure is invented.
    total: null,
    nextCursor: result.data.nextCursor,
    hasMore: result.data.hasMore,
    error: null,
  };
}

export type TraceDetailLoad =
  | { ok: true; trace: TraceDetail }
  | { ok: false; error: QueryError };

/** Detail for a deep-linked trace (`?trace=<uuid>`). */
export async function loadTraceDetail(
  context: DashboardContext,
  searchParams: DashboardSearchParams,
): Promise<TraceDetailLoad | null> {
  const traceId = firstValue(searchParams.trace);
  if (!traceId) return null;

  const result = await getTrace(context.session.user, traceId);
  return result.ok ? { ok: true, trace: result.data } : { ok: false, error: result.error };
}

/** Activity series for the overview chart. */
export async function loadActivity(
  context: DashboardContext,
): Promise<{ points: { label: string; traces: number; errors: number }[]; error: QueryError | null }> {
  const { getActivity } = await import("@/lib/queries/traces");

  const buckets = context.range === "1h" ? 12 : context.range === "24h" ? 12 : 14;
  const result = await getActivity(context.session.user, {
    projectId: context.projectId,
    since: rangeSince(context.range),
    buckets,
  });

  if (!result.ok) return { points: [], error: result.error };
  return { points: result.data, error: null };
}
