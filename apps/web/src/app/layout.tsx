import type { Metadata } from "next";
import { DM_Mono, Geist } from "next/font/google";
import { cn } from "@/lib/utils";
import { AppShell } from "@/components/app-shell";
import { getSession } from "@/lib/auth/session";
import { listProjects } from "@/lib/queries/traces";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });
const dmMono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-dm-mono",
});

export const metadata: Metadata = {
  title: "Hextrail — Agent Observability",
  description: "Inspect AI agent execution traces and debug failures.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Resolve the session once per render and hand the shell a plain user object.
  // A signed-out visitor gets an empty shell: no project data is fetched, and
  // there is nothing here that could leak.
  const session = await getSession();

  // One query, and a failure yields an empty list rather than crashing the
  // shell — the pages themselves surface the error state.
  const projectResult = session ? await listProjects(session.user) : null;
  const projects = projectResult?.ok ? projectResult.data : [];

  return (
    <html
      lang="en"
      className={cn("dark", "font-sans", geist.variable, dmMono.variable)}
    >
      <body>
        <AppShell
          user={
            session
              ? {
                  email: session.user.email,
                  displayName: session.user.displayName,
                }
              : { email: "Not signed in", displayName: null }
          }
          projects={projects.map((project) => ({
            id: project.id,
            name: project.name,
          }))}
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}
