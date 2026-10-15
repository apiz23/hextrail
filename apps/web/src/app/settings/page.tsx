import { redirect } from "next/navigation";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ApiKeysCard } from "@/components/api-keys/api-keys-card";
import { StatePanel } from "@/components/states/state-panel";
import { listApiKeys } from "@/lib/api-keys/keys";
import {
  loadDashboardContext,
  type DashboardSearchParams,
} from "@/lib/queries/dashboard";

/**
 * Settings.
 *
 * Shows the signed-in account and full API key management for the user's
 * projects. The raw key is not recoverable: only its SHA-256 hash is stored,
 * so there is nothing on this page that could leak a usable credential.
 */

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
}) {
  const loaded = await loadDashboardContext(await searchParams);

  if (!loaded.ok) {
    if (loaded.reason === "unauthorized") redirect("/login?next=/settings");
    return (
      <StatePanel
        tone="error"
        title="Could not load settings"
        description={loaded.message}
      />
    );
  }

  const { session, projects } = loaded.context;

  // Server-rendered first paint: the list is already authorized and scoped by
  // `listApiKeys`. The card takes over from here for create and revoke.
  const keyResult = await listApiKeys(session.user);
  const keys = keyResult.ok ? keyResult.data : [];

  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Configuration
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Your account and the ingestion keys issued to your projects.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Account</CardTitle>
          <CardDescription>
            Authenticated with a custom session — not Supabase Auth.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Email</span>
            <span className="truncate">{session.user.email}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Display name</span>
            <span>{session.user.displayName ?? "—"}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">User ID</span>
            <span className="break-all font-mono text-xs">
              {session.user.id}
            </span>
          </div>
        </CardContent>
      </Card>

      <ApiKeysCard
        initialKeys={keys}
        projects={projects.map((project) => ({
          id: project.id,
          name: project.name,
        }))}
        // A failed server render still yields a usable page: the card shows
        // its own error state and offers a retry.
        initialError={keyResult.ok ? null : "Could not load API keys."}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Appearance</CardTitle>
          <CardDescription>
            Hextrail ships dark-only. A theme switcher will land with persisted
            user preferences.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Current theme: <span className="text-foreground">Dark</span>
          </p>
        </CardContent>
      </Card>

      <Separator />
      <p className="text-xs text-muted-foreground">
        Keys are shown once at creation and only a hash is stored. To rotate a
        key, create a new one, deploy it, then revoke the old one.
      </p>
    </div>
  );
}
