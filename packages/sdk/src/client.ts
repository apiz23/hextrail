import type { IngestResponse, TraceEnvelope } from "./index.js";
import { HextrailError, isRetryableStatus } from "./errors.js";

/**
 * Minimal client for `POST /api/v1/traces`.
 *
 * DESIGN NOTES
 *
 * 1. Zero runtime dependencies. This package runs inside somebody else's agent
 *    process, so it must not drag a dependency tree in with it. Everything here
 *    uses `fetch`, `AbortController` and `setTimeout`, all of which are global
 *    in Node 18+ and every modern runtime.
 *
 * 2. The API key is a secret and is treated like one. It is held in a private
 *    field, sent only in the `Authorization` header, and never put into an
 *    error message, a thrown `Error`, or a log line. Error objects carry a
 *    status and a server-supplied message — nothing derived from the request.
 *
 * 3. Retries are safe *because* ingestion is idempotent. The server resolves a
 *    duplicate `(project, traceId)` to the original row and returns
 *    `duplicate: true`, so a retry after a timeout cannot create a second
 *    trace. The client only retries when that reasoning holds: network errors,
 *    timeouts, `429`, and `5xx`.
 */

export interface HextrailClientOptions {
  /**
   * A project API key (`hx_live_...`), created in the dashboard under Settings.
   *
   * Read it from the environment or a secret manager. Never commit it, and
   * never pass it from browser code — the SDK is for server-side/agent use.
   */
  apiKey: string;
  /**
   * Ingest endpoint. Required.
   *
   * There is no default. Hextrail has no hosted ingestion endpoint yet — the
   * `ingest.hextrail.ai` host in earlier versions of this package was never
   * provisioned and does not resolve in DNS. Defaulting to it turned a
   * configuration mistake into a DNS failure at the first `ingestTrace`, with
   * nothing in the error to say so.
   *
   * Requiring it moves that failure to construction time, where it belongs and
   * where the message can name the missing option.
   *
   * Must be an absolute `http`/`https` URL. A trailing slash is tolerated.
   * Use `LOCAL_ENDPOINT` for a Hextrail instance running on this machine.
   */
  endpoint: string;
  /** Per-attempt timeout in milliseconds. Defaults to 10_000. */
  timeoutMs?: number;
  /**
   * Additional attempts after a *retryable* failure. Defaults to 2, so a call
   * makes at most 3 attempts. Set to 0 to disable retries.
   */
  maxRetries?: number;
  /**
   * Overrides the computed backoff. Mainly for tests; the default honours the
   * server's `Retry-After` header and otherwise uses exponential backoff with
   * jitter.
   */
  retryDelayMs?: (attempt: number, retryAfterMs: number | null) => number;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * The ingestion route served by `apps/web` when you run Hextrail locally.
 *
 * Exported so the local-development flow is a one-liner rather than a URL
 * people retype — which is how a wrong host gets copied between projects.
 * Production callers pass their own deployed endpoint.
 */
export const LOCAL_ENDPOINT = "http://localhost:3000/api/v1/traces";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Backoff for a retryable failure.
 *
 * A `Retry-After` from the server always wins, because the server knows when
 * its window resets and guessing would just burn another rejected request. The
 * fallback is exponential (500ms, 1s, 2s, …) with full jitter, so a fleet of
 * agents that all failed at once does not retry in lockstep.
 */
function defaultRetryDelay(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, MAX_RETRY_DELAY_MS);
  }
  const exponential = 500 * 2 ** attempt;
  const jittered = Math.random() * exponential;
  return Math.min(jittered, MAX_RETRY_DELAY_MS);
}

/**
 * Parses `Retry-After` in either permitted form: delay-seconds or an HTTP-date.
 * Returns null when the header is absent or unparseable, so the caller falls
 * back to exponential backoff rather than waiting an undefined length of time.
 */
function parseRetryAfter(header: string | null, now: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;

  // delay-seconds, e.g. "30"
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;

  // HTTP-date, e.g. "Wed, 21 Oct 2026 07:28:00 GMT"
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) return Math.max(asDate - now, 0);

  return null;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Validates and normalises the configured endpoint.
 *
 * Throws a `TypeError` naming the option rather than letting a bad value
 * through to become a confusing transport error later. The checks are for
 * mistakes worth catching early — a missing value, a relative path, a typo'd
 * scheme, an unparseable string — not an attempt to police URLs.
 */
function resolveEndpoint(endpoint: unknown): string {
  if (typeof endpoint !== "string" || endpoint.trim() === "") {
    throw new TypeError(
      "HextrailClient: `endpoint` is required. Hextrail has no hosted ingestion " +
        "endpoint yet, so there is no default to fall back on. Pass the full " +
        "ingest URL, e.g. `endpoint: LOCAL_ENDPOINT` against a local Hextrail, " +
        "or the `https://<host>/api/v1/traces` of your deployment.",
    );
  }

  // Tolerate a trailing slash so a copy-pasted URL does not double up.
  const trimmed = endpoint.trim().replace(/\/+$/, "");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // The value is echoed here on purpose: an endpoint is not a secret, and
    // showing it is what makes a typo findable.
    throw new TypeError(
      `HextrailClient: \`endpoint\` is not a valid absolute URL (received ${JSON.stringify(trimmed)}). ` +
        "Expected something like `https://your-host/api/v1/traces`.",
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(
      `HextrailClient: \`endpoint\` must use http or https (received ${JSON.stringify(parsed.protocol)}).`,
    );
  }

  return trimmed;
}

export class HextrailClient {
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #retryDelay: (attempt: number, retryAfterMs: number | null) => number;
  readonly #fetch: typeof fetch;

  constructor(options: HextrailClientOptions) {
    // A JavaScript caller can omit the argument entirely. Guard before the
    // destructure, otherwise the failure is a bare "cannot read property of
    // undefined" that says nothing about what was missing.
    if (options === null || typeof options !== "object") {
      throw new TypeError(
        "HextrailClient: an options object is required, with `apiKey` and `endpoint`.",
      );
    }

    const { apiKey, endpoint, timeoutMs, maxRetries, retryDelayMs, fetch } =
      options;

    if (typeof apiKey !== "string" || apiKey.trim() === "") {
      // Deliberately does not echo the value — a mistaken `console.log` of this
      // error must not print a key.
      throw new TypeError("HextrailClient: `apiKey` is required.");
    }
    if (!apiKey.startsWith("hx_live_")) {
      throw new TypeError(
        "HextrailClient: `apiKey` does not look like a Hextrail key (expected an `hx_live_` prefix).",
      );
    }
    if (timeoutMs !== undefined && !(timeoutMs > 0)) {
      throw new TypeError("HextrailClient: `timeoutMs` must be greater than 0.");
    }
    if (maxRetries !== undefined && !(maxRetries >= 0)) {
      throw new TypeError("HextrailClient: `maxRetries` must be 0 or more.");
    }

    this.#apiKey = apiKey.trim();
    this.#endpoint = resolveEndpoint(endpoint);
    this.#timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetries = maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#retryDelay = retryDelayMs ?? defaultRetryDelay;
    this.#fetch = fetch ?? globalThis.fetch;

    if (typeof this.#fetch !== "function") {
      throw new TypeError(
        "HextrailClient: no global `fetch` is available. Use Node 18+, or pass a `fetch` implementation.",
      );
    }
  }

  /** The configured endpoint. Safe to log — contains no secret. */
  get endpoint(): string {
    return this.#endpoint;
  }

  /**
   * Sends one trace with its spans.
   *
   * Resolves with the server's response on success, including when the trace
   * was a duplicate. Rejects with a `HextrailError` on failure.
   *
   * Assert the payload against `TraceEnvelope` at build time. The server
   * validates at runtime and will answer `400` with per-field `details` if a
   * field is wrong.
   */
  async ingestTrace(payload: TraceEnvelope): Promise<IngestResponse> {
    if (payload?.schemaVersion !== 1) {
      throw new TypeError(
        "HextrailClient.ingestTrace: `schemaVersion` must be 1.",
      );
    }

    // Serialise once, outside the loop. A payload large enough to matter is
    // expensive to stringify, and the body is identical on every attempt.
    let body: string;
    try {
      body = JSON.stringify(payload);
    } catch (cause) {
      // Circular references, BigInt, etc. Surface it as a client-side error
      // rather than letting it escape as an opaque TypeError.
      throw new HextrailError({
        message:
          "The payload could not be serialised to JSON. Check for circular references or non-JSON values.",
        kind: "invalid_payload",
        retryable: false,
        cause,
      });
    }

    let lastError: HextrailError | undefined;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      try {
        return await this.#attempt(body);
      } catch (error) {
        const hextrailError =
          error instanceof HextrailError
            ? error
            : new HextrailError({
                message: "The request failed before a response was received.",
                kind: "network",
                retryable: true,
                cause: error,
              });

        lastError = hextrailError;
        const isLastAttempt = attempt === this.#maxRetries;
        if (!hextrailError.retryable || isLastAttempt) throw hextrailError;

        await sleep(this.#retryDelay(attempt, hextrailError.retryAfterMs));
      }
    }

    // Unreachable: the loop either returns or throws on the final attempt.
    throw lastError ?? new HextrailError({ message: "Request failed.", kind: "unknown", retryable: false });
  }

  /** One attempt, with its own timeout. Never retries internally. */
  async #attempt(body: string): Promise<IngestResponse> {
    const controller = new AbortController();
    // `unref` when available so a pending timer cannot hold the process open.
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const maybeUnref = timer as unknown as { unref?: () => void };
    maybeUnref.unref?.();

    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          // The key goes here and nowhere else.
          Authorization: `Bearer ${this.#apiKey}`,
        },
        body,
        signal: controller.signal,
      });
    } catch (cause) {
      // AbortError is this client's own timeout; anything else is transport.
      const aborted =
        cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError");
      throw new HextrailError({
        message: aborted
          ? `The request timed out after ${this.#timeoutMs}ms.`
          : "The request could not reach the ingestion endpoint.",
        kind: aborted ? "timeout" : "network",
        retryable: true,
        cause,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      try {
        return (await response.json()) as IngestResponse;
      } catch (cause) {
        throw new HextrailError({
          message: "The server returned a success status with an unreadable body.",
          status: response.status,
          kind: "invalid_response",
          // A 2xx that cannot be parsed is not worth retrying: the trace was
          // almost certainly stored, and a retry would only add a duplicate.
          retryable: false,
          cause,
        });
      }
    }

    throw await this.#errorFromResponse(response);
  }

  /**
   * Turns a non-2xx response into a typed error.
   *
   * Only `error.code` and `error.message` are read from the body — the server's
   * own contract. `details` is preserved verbatim because it describes the
   * caller's payload, which the caller already has.
   */
  async #errorFromResponse(response: Response): Promise<HextrailError> {
    const retryAfterMs = parseRetryAfter(
      response.headers.get("retry-after"),
      Date.now(),
    );

    let code: string | undefined;
    let message: string | undefined;
    let details: unknown;
    try {
      const body = (await response.json()) as {
        error?: { code?: unknown; message?: unknown; details?: unknown };
      };
      if (typeof body?.error?.code === "string") code = body.error.code;
      if (typeof body?.error?.message === "string") message = body.error.message;
      if (body?.error?.details !== undefined) details = body.error.details;
    } catch {
      // A proxy or gateway may answer with HTML. Fall through to a generic
      // message rather than surfacing the raw body, which could be anything.
    }

    const kind =
      response.status === 401 || response.status === 403
        ? "auth"
        : response.status === 429
          ? "rate_limit"
          : response.status >= 500
            ? "server"
            : "invalid_payload";

    return new HextrailError({
      message:
        message ??
        `Ingestion failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`,
      status: response.status,
      code,
      kind,
      retryable: isRetryableStatus(response.status),
      retryAfterMs,
      details,
    });
  }
}
