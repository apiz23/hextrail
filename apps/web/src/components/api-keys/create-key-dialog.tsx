"use client";

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ApiKeySummary } from "@/lib/api-keys/keys";

/**
 * Create-key dialog.
 *
 * Owns only the form. The request and the one-time-reveal handoff live in
 * `ApiKeysCard`, so the key value never passes through a component that keeps
 * it after the dialog closes.
 */
export function CreateKeyDialog({
  projects,
  disabled,
  onCreate,
}: {
  projects: readonly { id: string; name: string }[];
  disabled: boolean;
  onCreate: (input: { projectId: string; name: string }) => Promise<
    | { ok: true; key: ApiKeySummary; rawKey: string }
    | { ok: false; message: string }
  >;
}) {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the default project valid if the project list changes underneath us.
  useEffect(() => {
    if (projects.length > 0 && !projects.some((p) => p.id === projectId)) {
      setProjectId(projects[0].id);
    }
  }, [projects, projectId]);

  function reset() {
    setName("");
    setError(null);
    setPending(false);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!projectId) {
      setError("Select a project.");
      return;
    }

    setPending(true);
    const result = await onCreate({ projectId, name: name.trim() });
    setPending(false);

    if (result.ok) {
      // Close on success. The reveal dialog is opened by the parent, so this
      // dialog never holds the raw key.
      setOpen(false);
      reset();
      return;
    }

    setError(result.message);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5" disabled={disabled}>
          <Plus aria-hidden="true" className="size-3.5" />
          Create key
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Create an API key</DialogTitle>
            <DialogDescription>
              The key is scoped to one project and can only write traces to it.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="key-project">Project</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger id="key-project" className="w-full">
                  <SelectValue placeholder="Select a project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="key-name">Name</Label>
              <Input
                id="key-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. production-agent"
                maxLength={100}
                required
                autoComplete="off"
                aria-invalid={error ? true : undefined}
              />
              <p className="text-xs text-muted-foreground">
                A label to recognise this key by. It is not part of the secret.
              </p>
            </div>

            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !projectId || !name.trim()}>
              {pending ? "Creating…" : "Create key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
