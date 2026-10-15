"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
  Clock,
  Ellipsis,
  FolderKanban,
  Gauge,
  Hexagon,
  LogOut,
  Menu,
  Settings,
  Waypoints,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ProjectProvider, useProject } from "@/components/project-context";
import { TimeRangeProvider, useTimeRange } from "@/components/time-range-context";
import { TIME_RANGES, type TimeRangeKey } from "@/lib/data/time-ranges";
import { cn } from "@/lib/utils";

export interface ShellUser {
  email: string;
  displayName: string | null;
}

const NAV_ITEMS = [
  { href: "/", label: "Overview", icon: Gauge },
  { href: "/traces", label: "Traces", icon: Waypoints },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

function pageTitle(pathname: string): string {
  const match = NAV_ITEMS.find((item) =>
    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href),
  );
  return match?.label ?? "Overview";
}

function Brand() {
  return (
    <Link
      href="/"
      className="flex items-center gap-2 px-1 text-base font-semibold tracking-tight text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        aria-hidden="true"
        className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground"
      >
        <Hexagon className="size-4" />
      </span>
      hextrail
    </Link>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Main navigation" className="flex flex-col gap-1">
      {NAV_ITEMS.map((item) => {
        const active =
          item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active &&
                "bg-accent font-medium text-accent-foreground",
            )}
          >
            <Icon aria-hidden="true" className="size-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function TimeRangeSelect() {
  const { range, setRange } = useTimeRange();

  return (
    <Select
      value={range}
      onValueChange={(value) => setRange(value as TimeRangeKey)}
    >
      <SelectTrigger
        className="h-9 w-[152px] gap-1.5 text-xs"
        aria-label="Time range"
      >
        <Clock aria-hidden="true" className="size-3.5 opacity-60" />
        <SelectValue placeholder="Time range" />
      </SelectTrigger>
      <SelectContent>
        {TIME_RANGES.map((timeRange) => (
          <SelectItem key={timeRange.key} value={timeRange.key}>
            {timeRange.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ProjectSelect() {
  const { projectId, projects, setProjectId } = useProject();

  // A single project needs no selector — the choice is not real.
  if (projects.length <= 1) return null;

  return (
    <Select
      value={projectId ?? "all"}
      onValueChange={(value) => setProjectId(value === "all" ? null : value)}
    >
      <SelectTrigger
        className="h-9 w-[176px] gap-1.5 text-xs"
        aria-label="Select project"
      >
        <FolderKanban aria-hidden="true" className="size-3.5 opacity-60" />
        <SelectValue placeholder="All projects" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All projects</SelectItem>
        {projects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            {project.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SignedInBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className="hidden border-success/30 bg-success/10 text-success sm:inline-flex"
        >
          Live
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        Connected to your database. Data below is persisted.
      </TooltipContent>
    </Tooltip>
  );
}

function AccountMenu({ user }: { user: ShellUser }) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const label = user.displayName ?? user.email;
  const initial = label.slice(0, 1).toUpperCase();

  async function onSignOut() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-xs text-muted-foreground"
        >
          <span
            aria-hidden="true"
            className="grid size-5 place-items-center rounded-full bg-muted text-[10px] font-semibold text-foreground"
          >
            {initial}
          </span>
          <span className="hidden max-w-[160px] truncate sm:inline">{label}</span>
          <Ellipsis aria-hidden="true" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate text-xs font-medium text-foreground">
            {label}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {user.email}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings aria-hidden="true" className="size-4" />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSignOut} disabled={signingOut}>
          <LogOut aria-hidden="true" className="size-4" />
          {signingOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TopBar({ user }: { user: ShellUser }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur md:px-6">
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Open navigation menu"
          >
            <Menu aria-hidden="true" className="size-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-6 p-4">
            <Brand />
            <SidebarNav onNavigate={() => setMenuOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 items-center gap-1.5 text-sm">
        <span className="hidden text-muted-foreground sm:inline">Workspace</span>
        <span aria-hidden="true" className="hidden text-muted-foreground/60 sm:inline">
          /
        </span>
        <span className="truncate font-medium text-foreground">
          {pageTitle(pathname)}
        </span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <SignedInBadge />
        <ProjectSelect />
        <TimeRangeSelect />
        <AccountMenu user={user} />
      </div>
    </header>
  );
}

export function AppShell({
  user,
  projects,
  children,
}: {
  user: ShellUser;
  projects: readonly { id: string; name: string }[];
  children: ReactNode;
}) {
  return (
    <ProjectProvider projects={projects}>
      <TimeRangeProvider>
        <TooltipProvider delayDuration={250}>
          <div className="flex min-h-screen w-full">
            <a
              href="#main"
              className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow-lg"
            >
              Skip to content
            </a>

            <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-6 border-r bg-sidebar p-4 md:flex">
              <Brand />
              <SidebarNav />
              <div className="mt-auto">
                <Separator className="mb-4" />
                <p className="truncate text-xs font-medium text-foreground">
                  {user.displayName ?? user.email}
                </p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {user.email}
                </p>
              </div>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
              <TopBar user={user} />
              <main
                id="main"
                className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-6"
              >
                {children}
              </main>
            </div>
          </div>
        </TooltipProvider>
      </TimeRangeProvider>
    </ProjectProvider>
  );
}
