# @hextrail/sdk

Official TypeScript SDK for [Hextrail](https://hextrail.ai) — send AI agent
execution traces to your Hextrail project.

Zero dependencies. Runs on Node 18+, Bun, Deno, Cloudflare Workers, and any
runtime with a global `fetch`.

## Install

```bash
npm install @hextrail/sdk
```

```bash
pnpm add @hextrail/sdk
```

```bash
yarn add @hextrail/sdk
```

## Get an API key

In the dashboard, go to **Settings → Ingestion API keys → Create key**.

The key is shown **once**. Only its SHA-256 hash is stored, so it cannot be
retrieved later — if you lose it, revoke that key and create a new one.

A key is scoped to a single project and can only write traces to it.

Keep it out of source control. Use an environment variable or a secret manager:

```bash
# .env — never commit this file
HEXTRAIL_API_KEY=hx_live_...
```

> Do not use this SDK in browser code. The key authorises writes to your
> project; anything shipped to a browser is public.

## Quickstart

```ts
import { HextrailClient, type TraceEnvelope } from "@hextrail/sdk";

const hextrail = new HextrailClient({
  apiKey: process.env.HEXTRAIL_API_KEY!,
  // Required — Hextrail has no hosted endpoint yet. See "Options" below.
  endpoint: process.env.HEXTRAIL_ENDPOINT!,
});

const startedAt = new Date();

// ... run your agent ...

const payload: TraceEnvelope = {
  schemaVersion: 1,
  trace: {
    traceId: "trc_8f2a91",       // your own id; unique per project
    name: "support-assistant",
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    status: "ok",
    environment: "production",
  },
  spans: [
    {
      spanId: "spn_1",
      traceId: "trc_8f2a91",
      name: "llm.completion",
      kind: "llm",
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      status: "ok",
      attributes: { model: "gpt-5", inputTokens: 812, outputTokens: 240 },
    },
  ],
};

const result = await hextrail.ingestTrace(payload);
console.log(result.traceId, result.duplicate);
```

### Local development

Run the Hextrail web app (`pnpm --filter web dev` in the repository) and use the
exported `LOCAL_ENDPOINT`, which addresses its ingestion route in one import:

```ts
import { HextrailClient, LOCAL_ENDPOINT } from "@hextrail/sdk";

const hextrail = new HextrailClient({
  apiKey: process.env.HEXTRAIL_API_KEY!,
  endpoint: LOCAL_ENDPOINT, // http://localhost:3000/api/v1/traces
});
```

`LOCAL_ENDPOINT` is a constant, not a default — nothing is inferred when
`endpoint` is omitted. Point it at a different origin when the app is not on
port 3000:

```ts
const hextrail = new HextrailClient({
  apiKey: process.env.HEXTRAIL_API_KEY!,
  endpoint: `${process.env.HEXTRAIL_BASE_URL ?? "http://localhost:3000"}/api/v1/traces`,
});
```

Create a key locally via **Settings → Ingestion API keys**, then open
`http://localhost:3000/traces` and the trace appears.

## Reporting failures

Use `onError` rather than `try`/`catch` at every call site:

```ts
const result = await hextrail
  .ingestTrace(payload)
  .catch((error: HextrailError) => {
    // `error` never contains the API key or the payload.
    if (error.isRateLimited) {
      console.warn(`Throttled; retry in ${error.retryAfterMs}ms`);
    } else if (error.isAuthError) {
      console.error("Check HEXTRAIL_API_KEY — it may be revoked.");
    } else {
      console.error(error.kind, error.status, error.message);
    }
    return null;
  });
```

### `HextrailError`

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `"network" \| "timeout" \| "auth" \| "rate_limit" \| "invalid_payload" \| "server" \| "invalid_response" \| "unknown"` | Machine-readable cause. Switch on this. |
| `status` | `number?` | HTTP status, when a response arrived. |
| `code` | `string?` | The server's `error.code`, e.g. `rate_limited`. |
| `retryable` | `boolean` | Whether a retry could succeed. Reflects retries already made. |
| `retryAfterMs` | `number \| null` | Server-advised wait, from `Retry-After`. |
| `details` | `unknown` | Per-field validation errors on a `400`. |

`error.isAuthError` and `error.isRateLimited` are convenience getters.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `apiKey` | — | Required. Must start with `hx_live_`. |
| `endpoint` | — | **Required.** Absolute `http`/`https` ingest URL. A trailing slash is tolerated. |
| `timeoutMs` | `10000` | Per attempt, not per call. |
| `maxRetries` | `2` | Extra attempts. Total attempts = `maxRetries + 1`. |
| `retryDelayMs` | exponential + jitter | Override the backoff. |
| `fetch` | global `fetch` | Injectable for testing. |

### Why `endpoint` is required

Hextrail does not host a public ingestion endpoint yet. Earlier `0.1.x`
releases defaulted to `https://ingest.hextrail.ai/api/v1/traces`; that host was
never provisioned and does not resolve in DNS. Defaulting to it converted a
missing configuration into a DNS failure at your first `ingestTrace`, with an
error that never mentioned the endpoint.

`endpoint` is now required, so a missing or malformed value fails at
construction with a message naming the option — before any trace is lost:

```ts
new HextrailClient({ apiKey: process.env.HEXTRAIL_API_KEY! });
// TypeError: HextrailClient: `endpoint` is required. Hextrail has no hosted
// ingestion endpoint yet, so there is no default to fall back on. …
```

`LOCAL_ENDPOINT` is exported for local development (see below). For a deployed
Hextrail, pass your own ingest URL.

## Retries and idempotency

Ingestion is **idempotent** on `(project, traceId)`. Resubmitting the same
`traceId` returns the original trace with `duplicate: true` and a `200` — it
never creates a second trace.

That is what makes retrying safe, so the client retries automatically:

| Outcome | Retried? | Why |
| --- | --- | --- |
| Network error | Yes | Transport failure; the request may never have arrived. |
| Timeout | Yes | Same, and a duplicate result is harmless. |
| `429` | Yes | Honours `Retry-After` when present. |
| `5xx` | Yes | Transient server failure. |
| `400`, `413` | No | The payload will fail again identically. |
| `401`, `403` | No | A bad or revoked key will still be bad. |
| `2xx` with an unreadable body | No | The trace was likely stored; retrying risks a needless duplicate. |

`403` means a `projectId` in the body did not match the key's project. Omit
`projectId` — the key already determines the project — and it cannot happen.

Backoff is exponential (500ms, 1s, 2s) with full jitter. A `Retry-After` header
always takes precedence. Waits are capped at 30s.

To disable retries entirely:

```ts
new HextrailClient({ apiKey, maxRetries: 0 });
```

## Payload reference

`TraceEnvelope`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `schemaVersion` | `1` | Yes | Must be exactly `1`. |
| `trace` | `TraceRecord` | Yes | |
| `spans` | `SpanRecord[]` | Yes | Max 500. |

`TraceRecord`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `traceId` | `string` | Yes | Your id, unique per project. Max 200 chars. |
| `name` | `string` | Yes | Max 200 chars. |
| `startedAt` | `string` | Yes | ISO 8601. |
| `status` | `"ok" \| "error" \| "running"` | Yes | |
| `endedAt` | `string` | No | ISO 8601. Must not precede `startedAt`. |
| `environment` | `string` | No | Max 100 chars. |
| `projectId` | `string` | No | Usually omit. If set, must match the key's project. |
| `metadata` | `object` | No | Redacted by key name. |

`SpanRecord`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `spanId` | `string` | Yes | Max 200 chars. |
| `traceId` | `string` | Yes | Should match the parent trace. |
| `name` | `string` | Yes | Max 200 chars. |
| `kind` | `"agent" \| "llm" \| "tool" \| "retriever" \| "chain" \| "custom"` | Yes | |
| `startedAt` | `string` | Yes | ISO 8601. |
| `status` | `"ok" \| "error" \| "running"` | Yes | |
| `endedAt` | `string` | No | Must not precede `startedAt`. |
| `parentSpanId` | `string` | No | Another span in the same trace. |
| `attributes` | `object` | No | Redacted by key name. |
| `error` | `{ name, message }` | No | |

Runtime values (`SPAN_KINDS`, `TRACE_STATUSES`, `SCHEMA_VERSION`,
`MAX_SPANS_PER_TRACE`) are exported from `@hextrail/sdk/schema` for consumers
writing their own validator.

## Redaction

Before storage, values under credential-shaped key names (`password`,
`api_key`, `authorization`, `access_token`, …) and a small set of
high-confidence credential shapes (bearer tokens, JWTs, AWS and GitHub keys,
private key blocks) are replaced with `[REDACTED]`.

**This is not PII detection.** Redaction matches key *names*, not content. A
secret under an innocent name (`notes`, `input`) is stored verbatim, and
personal data is not detected at all. Do not send prompts, secrets, or
production telemetry you would not want stored.

## Limits

| Limit | Value |
| --- | --- |
| Request body | ~1 MB |
| Spans per trace | 500 |
| Rate limit | 600 requests / 60s per API key (server-configurable) |

Exceeding the rate limit returns `429` with `Retry-After`, which the client
honours automatically.

## TypeScript

Written in TypeScript and shipped with declarations and declaration maps. It is
ESM-only and `"type": "module"`. On Node 18+ this is native. From CommonJS:

```js
const { HextrailClient } = await import("@hextrail/sdk");
```

## License

MIT
