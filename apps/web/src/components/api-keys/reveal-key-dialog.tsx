"use client";

import { useEffect, useState } from "react";
import { Check, Copy, KeyRound, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * One-time display of a newly created key.
 *
 * THE WHOLE POINT OF THIS COMPONENT is that the raw key lives in React state
 * for the lifetime of one dialog and nowhere else. Specifically it does NOT:
 *
 *   - write to `localStorage` / `sessionStorage`
 *   - put the key in the URL or a query parameter
 *   - `console.log` it, or include it in an error report
 *   - survive a reload — closing the dialog drops the value, and the key
 *     cannot be recovered afterwards
 *
 * That is a deliberate design constraint, not an omission. A "key manager"
 * that can show you the key again later is one that stored it.
 *
 * The copy action uses the async Clipboard API and falls back to a manual
 * selection hint when it is unavailable (e.g. an insecure origin), so the user
 * is never left without a way to get the value.
 */
export function RevealKeyDialog({
  rawKey,
  keyName,
  onClose,
}: {
  /** The raw key. Non-null only while the dialog is open. */
  rawKey: string | null;
  keyName: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  // Reset the feedback state whenever a new key is revealed, so a stale
  // "Copied" badge can never be read as applying to a different key.
  useEffect(() => {
    if (rawKey) {
      setCopied(false);
      setCopyFailed(false);
    }
  }, [rawKey]);

  async function copy() {
    if (!rawKey) return;
    try {
      await navigator.clipboard.writeText(rawKey);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      // Clipboard access can be denied by permissions policy. Fall back to
      // prompting a manual copy rather than silently doing nothing.
      setCopied(false);
      setCopyFailed(true);
    }
  }

  return (
    <Dialog
      open={rawKey !== null}
      onOpenChange={(open) => {
        // Closing is the only way to dismiss, and it is what discards the key.
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound aria-hidden="true" className="size-4" />
            Copy your API key now
          </DialogTitle>
          <DialogDescription>
            This is the only time <span className="font-medium">{keyName}</span>{" "}
            will be shown. Only a hash is stored, so it cannot be displayed
            again — if you lose it, revoke this key and create a new one.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3">
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-warning"
            />
            <p className="text-xs leading-relaxed text-warning">
              Store this in your agent&apos;s secret manager or environment
              configuration. Do not commit it, paste it into a chat, or put it
              in client-side code.
            </p>
          </div>

          <div className="flex items-stretch gap-2">
            {/* Read-only and selectable: if the clipboard is unavailable the
                user can still select and copy by hand. */}
            <code
              className="min-w-0 flex-1 select-all break-all rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs"
              data-testid="raw-api-key"
            >
              {rawKey}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-auto shrink-0 gap-1.5"
              onClick={copy}
            >
              {copied ? (
                <>
                  <Check aria-hidden="true" className="size-3.5" />
                  Copied
                </>
              ) : (
                <>
                  <Copy aria-hidden="true" className="size-3.5" />
                  Copy
                </>
              )}
            </Button>
          </div>

          {/* Announced to assistive tech, and visible when the clipboard
              API is blocked. */}
          <p aria-live="polite" className="min-h-4 text-xs text-muted-foreground">
            {copied ? "Key copied to the clipboard." : null}
            {copyFailed
              ? "Clipboard access was blocked. Select the key above and copy it manually."
              : null}
          </p>
        </div>

        <DialogFooter>
          <Button onClick={onClose}>I have stored the key</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
