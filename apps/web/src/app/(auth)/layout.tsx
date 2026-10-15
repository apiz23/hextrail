/**
 * Public authentication layout.
 *
 * Companion to `(dashboard)/layout.tsx`. Like it, this is a route group and
 * therefore adds no URL segment — `/login` is still `/login`.
 *
 * It is intentionally almost empty, and that is the point: the dashboard shell
 * is rendered by the dashboard layout, so a signed-out visitor on this route
 * receives only this markup. There is no sidebar to hide, because none is ever
 * rendered here.
 */
export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-screen flex-col bg-background">{children}</div>
  );
}
