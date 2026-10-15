/**
 * Sanitises a post-login redirect target.
 *
 * The `?next=` parameter is client input that decides where the browser goes
 * after sign-in, so it is a genuine open-redirect surface. Only an absolute
 * *path* on this origin is allowed.
 *
 * Rejected, all falling back to `/`:
 *   - anything without a leading slash (`traces`)
 *   - protocol-relative URLs (`//evil.com`), which browsers treat as absolute
 *   - the backslash variants (`/\evil.com`) that some browsers normalise to
 *     `//`
 *   - a scheme smuggled behind the slash (`/javascript:alert(1)`)
 *   - absolute URLs (`https://evil.com`)
 *
 * Lives in its own module, free of JSX and React, so it is a plain function
 * that can be unit-tested directly.
 */
export function safeNext(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return "/";
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(value)) return "/";
  return value;
}
