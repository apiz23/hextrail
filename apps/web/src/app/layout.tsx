import type { Metadata } from "next";
import { DM_Mono, Geist } from "next/font/google";
import { cn } from "@/lib/utils";
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

/**
 * Root layout.
 *
 * Deliberately knows nothing about the session. It renders only the document
 * shell — `<html>`, `<body>`, fonts — so its output is identical for every
 * visitor. Anything session-dependent lives in a nested layout under a route
 * group, which is what keeps the two render trees from disagreeing.
 *
 * This used to call `getSession()` and render the dashboard shell for
 * everyone. That meant `/login` rendered a sidebar for a signed-out visitor,
 * and because the root layout's output depended on a cookie, the server HTML
 * and the client's first render could differ — a hydration mismatch with no
 * way to fix it except by removing the session read from here.
 */
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={cn("dark", "font-sans", geist.variable, dmMono.variable)}
    >
      <body>{children}</body>
    </html>
  );
}
