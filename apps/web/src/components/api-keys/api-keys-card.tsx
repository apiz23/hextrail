"use client";

import { useCallback, useMemo, useState } from "react";
import { KeyRound, Loader2, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { StatePanel } from "@/components/states/state-panel";
import { CreateKeyDialog } from "@/components/api-keys/create-key-dialog";
import { RevealKeyDialog } from "@/components/api-keys/reveal-key-dialog";
import type { ApiKeySummary } from "@/lib/api-keys/keys";

/**
 * API key management.
 *
 * All three operations talk to the same session-authenticated JSON API the
 * settings page uses, and every mutation refetches rather than patching local
 * state. That keeps the server the single source of truth: after a revoke the
 * list reflects exactly what the database holds, instead of what this
 * component assumed it would hold.
 *
 * The raw key is held in one piece of state, `revealed`, set only by a
 * successful create, and cleared the moment the reveal dialog closes. It is
 * never written to storage.
 */

interface RevealState {
  rawKey: string;
  keyName: string;
}

export function ApiKeysCard({
  initialKeys,
  projects,
  initialError,
}: {
  initialKeys: ApiKeySummary[];
  projects: readonly { id: string; name: string }[];
  initialError: string | null;
}) {
  const [keys, setKeys] = useState<ApiKeySummary[]>(initialKeys);
  const [error, setError] = useState<string | null>(initialError);
  const [refreshing, setRefreshing] = useState(false);

  // The one-time secret. Never persisted, never logged.
  const [revealed, setRevealed] = useState<RevealState | null>(null);

  const [pendingRevoke, setPendingRevoke] = useState<ApiKeySummary | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/keys", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (response.status === 401) {
        setError("Your session has expired. Sign in again.");
        return;
      }
      if (!response.ok) {
        setError("Could not load API keys.");
        return;
      }
      const body = await response.json();
      setKeys(body.keys ?? []);
      setError(null);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  const create = useCallback(
    async ({ projectId, name }: { projectId: string; name: string }) => {
      try {
        const response = await fetch("/api/keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({ projectId, name }),
        });

        const body = await response.json().catch(() => null);

        if (response.status === 401) {
          return { ok: false as const, message: "Your session has expired." };
        }
        if (!response.ok) {
          return {
            ok: false as const,
            message:
              body?.error?.message ?? "Could not create the key. Try again.",
          };
        }

        // Hand the secret straight to the reveal dialog, then refetch so the
        // list shows the new key by its prefix.
        setRevealed({ rawKey: body.rawKey, keyName: body.key.name });
        await refresh();

        return { ok: true as const, key: body.key, rawKey: body.rawKey };
      } catch {
        return {
          ok: false as const,
          message: "Could not reach the server. Check your connection.",
        };
      }
    },
    [refresh],
  );

  const revoke = useCallback(
    async (key: ApiKeySummary) => {
      setRevoking(true);
      setRevokeError(null);
      try {
        const response = await fetch(`/api/keys/${key.id}`, {
          method: "DELETE",
          cache: "no-store",
        });

        if (response.status === 401) {
          setRevokeError("Your session has expired. Sign in again.");
          return;
        }
        // 404 means the key is not this user's, or no longer exists. Either
        // way it is not in their list, so refetching is the right response.
        if (!response.ok && response.status !== 404) {
          const body = await response.json().catch(() => null);
          setRevokeError(
            body?.error?.message ?? "Could not revoke the key. Try again.",
          );
          return;
        }

        setPendingRevoke(null);
        await refresh();
      } catch {
        setRevokeError("Could not reach the server. Check your connection.");
      } finally {
        setRevoking(false);
      }
    },
    [refresh],
  );

  const { active, revoked } = useMemo(() => {
    const activeKeys = keys.filter((key) => key.revokedAt === null);
    const revokedKeys = keys.filter((key) => key.revokedAt !== null);
    return { active: activeKeys, revoked: revokedKeys };
  }, [keys]);

  const noProjects = projects.length === 0;

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Ingestion API keys</CardTitle>
            <CardDescription>
              Only a hash and a display prefix are stored. A key is shown once
              at creation and cannot be recovered afterwards.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={refresh}
              disabled={refreshing}
              aria-label="Refresh API keys"
            >
              <RefreshCw
                aria-hidden="true"
                className={refreshing ? "size-3.5 animate-spin" : "size-3.5"}
              />
              Refresh
            </Button>
            <CreateKeyDialog
              projects={projects}
              disabled={noProjects}
              onCreate={create}
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {noProjects ? (
          <StatePanel
            icon={<KeyRound className="size-5" />}
            title="No projects yet"
            description="Keys are scoped to a project. Create a project first, then issue a key for it."
          />
        ) : error ? (
          <StatePanel
            tone="error"
            title="Could not load API keys"
            description={error}
            action={
              <Button variant="outline" size="sm" onClick={refresh}>
                Try again
              </Button>
            }
          />
        ) : (
          <>
            {revoking || refreshing ? (
              <p
                className="flex items-center gap-2 text-xs text-muted-foreground"
                aria-live="polite"
              >
                <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                {revoking ? "Revoking…" : "Refreshing…"}
              </p>
            ) : null}

            {revokeError ? (
              <p role="alert" className="text-sm text-destructive">
                {revokeError}
              </p>
            ) : null}

            {keys.length === 0 ? (
              <StatePanel
                icon={<KeyRound className="size-5" />}
                title="No API keys yet"
                description="Create one to start sending traces with POST /api/v1/traces."
              />
            ) : (
              <ul className="divide-y">
                {[...active, ...revoked].map((key) => (
                  <KeyRow
                    key={key.id}
                    apiKey={key}
                    onRevoke={() => {
                      setRevokeError(null);
                      setPendingRevoke(key);
                    }}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>

      {/* One-time reveal. Closing it discards the key. */}
      <RevealKeyDialog
        rawKey={revealed?.rawKey ?? null}
        keyName={revealed?.keyName ?? ""}
        onClose={() => setRevealed(null)}
      />

      {/* Revocation confirmation — destructive, so it is confirmed. */}
      <AlertDialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => {
          if (!open && !revoking) setPendingRevoke(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke this API key?
            </AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono">{pendingRevoke?.prefix}…</span> (
              {pendingRevoke?.name}) will stop authenticating immediately. Any
              agent using it will start receiving 401 responses. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={revoking}
              onClick={(event) => {
                // Keep the dialog open while the request is in flight so the
                // result — including a failure — is visible in place.
                event.preventDefault();
                if (pendingRevoke) void revoke(pendingRevoke);
              }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {revoking ? "Revoking…" : "Revoke key"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/** One key row. Shows prefix and metadata only — never a hash. */
function KeyRow({
  apiKey,
  onRevoke,
}: {
  apiKey: ApiKeySummary;
  onRevoke: () => void;
}) {
  const revoked = apiKey.revokedAt !== null;

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <code className="truncate font-mono text-xs">
            {apiKey.prefix}…
          </code>
          {revoked ? (
            <Badge
              variant="outline"
              className="border-destructive/30 bg-destructive/10 text-destructive"
            >
              Revoked
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="border-success/30 bg-success/10 text-success"
            >
              Active
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {apiKey.name} · {apiKey.projectName}
        </p>
      </div>

      <div className="flex items-center gap-4">
        <div className="text-right text-xs text-muted-foreground">
          <p>
            Created {new Date(apiKey.createdAt).toLocaleDateString("en-US")}
          </p>
          <p>
            {revoked
              ? `Revoked ${new Date(apiKey.revokedAt!).toLocaleDateString("en-US")}`
              : apiKey.lastUsedAt
                ? `Last used ${new Date(apiKey.lastUsedAt).toLocaleDateString("en-US")}`
                : "Never used"}
          </p>
        </div>

        {revoked ? null : (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-destructive hover:text-destructive"
            onClick={onRevoke}
            aria-label={`Revoke key ${apiKey.prefix}`}
          >
            Revoke
          </Button>
        )}
      </div>
    </li>
  );
}
