"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";

/**
 * Selected-project state, carried in the URL as `?project=<uuid>`.
 *
 * The URL is the source of truth rather than React state. That matters for
 * three reasons:
 *   - A link to a filtered view is shareable and survives a reload.
 *   - The server component can read the same value and scope its query, so the
 *     selection never depends on client-side filtering of data the user should
 *     not have received.
 *   - The back button behaves.
 *
 * `null` means "all projects the user owns".
 */

export interface ProjectOption {
  id: string;
  name: string;
}

interface ProjectContextValue {
  /** Currently selected project id, or null for all projects. */
  projectId: string | null;
  selected: ProjectOption | null;
  projects: readonly ProjectOption[];
  setProjectId: (projectId: string | null) => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({
  projects,
  children,
}: {
  projects: readonly ProjectOption[];
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const raw = searchParams.get("project");
  // Only accept a project the viewer actually owns. An id from the URL is
  // untrusted input; an unknown one degrades to "all projects" rather than
  // being forwarded to any query.
  const projectId = useMemo(
    () => (raw && projects.some((project) => project.id === raw) ? raw : null),
    [raw, projects],
  );

  const selected = useMemo(
    () => projects.find((project) => project.id === projectId) ?? null,
    [projects, projectId],
  );

  const setProjectId = useCallback(
    (next: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next) params.set("project", next);
      else params.delete("project");
      // Opening a detail sheet from a different project would show a trace that
      // is not in the new scope, so drop it.
      params.delete("trace");
      params.delete("cursor");
      const query = params.toString();
      router.push(query ? `${pathname}?${query}` : pathname);
    },
    [pathname, router, searchParams],
  );

  const value = useMemo(
    () => ({ projectId, selected, projects, setProjectId }),
    [projectId, selected, projects, setProjectId],
  );

  return (
    <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error("useProject must be used within a ProjectProvider");
  }
  return context;
}
