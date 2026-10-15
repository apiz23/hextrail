/**
 * Error types for the Hextrail SDK.
 *
 * A single error class with a discriminative `kind` is easier to handle than a
 * hierarchy: callers switch on one field, and adding a case later is not a
 * breaking change.
 *
 * Deliberately narrow: an error carries the HTTP status, the server's error
 * code and message, and the server's `details`. It never carries the request
 * body or the API key, so an error that ends up in a log, an APM trace, or a
 * crash report cannot leak either.
 */

export type HextrailErrorKind =
  /** No response: DNS, TLS, connection refused, socket reset. */
  | "network"
  /** The per-attempt timeout elapsed. */
  | "timeout"
  /** `401` or `403` — missing, invalid, revoked, or wrong-project key. */
  | "auth"
  /** `429` — the per-key rate limit was exceeded. */
  | "rate_limit"
  /** `400`/`413` — the server rejected the payload. */
  | "invalid_payload"
  /** `5xx` — the server failed. */
  | "server"
  /** A 2xx whose body could not be parsed. */
  | "invalid_response"
  | "unknown";

export interface HextrailErrorInit {
  message: string;
  kind: HextrailErrorKind;
  /** Whether retrying the same request could plausibly succeed. */
  retryable: boolean;
  status?: number;
  code?: string;
  retryAfterMs?: number | null;
  details?: unknown;
  cause?: unknown;
}

/** HTTP statuses where resending the identical request may succeed. */
export function isRetryableStatus(status: number): boolean {
  // 408 request timeout, 425 too early, 429 rate limited, and any 5xx.
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export class HextrailError extends Error {
  /** Machine-readable cause. Switch on this. */
  readonly kind: HextrailErrorKind;
  /** HTTP status, when a response was received. */
  readonly status?: number;
  /** The server's `error.code`, e.g. `rate_limited`. */
  readonly code?: string;
  /** Whether a retry could succeed. Reflects what the client already did. */
  readonly retryable: boolean;
  /** Server-advised wait before retrying, in milliseconds. */
  readonly retryAfterMs: number | null;
  /** Per-field validation errors, when the server supplies them. */
  readonly details?: unknown;

  constructor(init: HextrailErrorInit) {
    super(init.message, { cause: init.cause });
    this.name = "HextrailError";
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.retryable = init.retryable;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.details = init.details;

    // Keep `instanceof` working when compiled down to ES5-era targets.
    Object.setPrototypeOf(this, HextrailError.prototype);
  }

  /** True when the key is missing, malformed, revoked, or not for this project. */
  get isAuthError(): boolean {
    return this.kind === "auth";
  }

  /** True when the request was throttled. */
  get isRateLimited(): boolean {
    return this.kind === "rate_limit";
  }
}
