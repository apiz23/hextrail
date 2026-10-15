import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural tests for the route-group split.
 *
 * The hydration mismatch came from the root layout reading the session, so the
 * property worth locking down is a negative one: the root layout must not
 * import or call anything session-related. That is a property of the source,
 * so it is asserted against the source.
 *
 * These are deliberately narrow. They do not claim the app renders correctly —
 * the access decision is covered by `require-session.test.ts` and the rendered
 * behaviour was verified against a running server. They guard against the
 * specific regression of re-coupling the root layout to the session.
 */

const APP_DIR = join(import.meta.dirname);

function source(relativePath: string): string {
  return readFileSync(join(APP_DIR, relativePath), "utf8");
}

/** Strips comments so a file cannot pass by merely mentioning a symbol. */
function code(relativePath: string): string {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("root layout", () => {
  const root = code("layout.tsx");

  it("does not import the session layer", () => {
    expect(root).not.toContain("@/lib/auth/session");
    expect(root).not.toContain("require-session");
    expect(root).not.toContain("getSession");
  });

  it("does not import the dashboard shell", () => {
    expect(root).not.toContain("app-shell");
    expect(root).not.toContain("AppShell");
  });

  it("does not query the database", () => {
    expect(root).not.toContain("listProjects");
    expect(root).not.toContain("@/lib/queries");
  });

  it("is a synchronous component, so it cannot await a session", () => {
    expect(root).not.toMatch(/export\s+default\s+async\s+function\s+RootLayout/);
  });
});

describe("(dashboard) layout", () => {
  const dashboard = code("(dashboard)/layout.tsx");

  it("gates on requireSession and redirects when it returns nothing", () => {
    expect(dashboard).toContain("requireSession");
    expect(dashboard).toMatch(/if\s*\(\s*!\s*access\s*\)\s*redirect\(/);
  });

  it("renders the dashboard shell", () => {
    expect(dashboard).toContain("AppShell");
  });

  it("exists as a route group, which contributes no URL segment", () => {
    // The directory name is the guarantee: parentheses are excluded from the
    // URL, so moving pages here did not change their paths.
    expect(() => source("(dashboard)/layout.tsx")).not.toThrow();
  });
});

describe("(auth) layout", () => {
  const auth = code("(auth)/layout.tsx");

  it("does not read the session", () => {
    expect(auth).not.toContain("getSession");
    expect(auth).not.toContain("requireSession");
    expect(auth).not.toContain("@/lib/auth");
  });

  it("does not render the dashboard shell", () => {
    expect(auth).not.toContain("AppShell");
    expect(auth).not.toContain("app-shell");
  });
});
