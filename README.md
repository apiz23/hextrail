# Hextrail

**AI agent observability and debugging.** See every step. Find every failure.

Hextrail is an early-stage, TypeScript-first project for capturing and inspecting AI-agent execution traces.

Working today: project-scoped API-key ingestion with atomic persistence and
payload redaction, distributed rate limiting, custom (non-Supabase) session
authentication, and a dashboard that reads persisted traces from PostgreSQL.

## Stack

- pnpm workspaces + TypeScript (strict mode)
- Next.js App Router (web app)
- Tailwind CSS v4 (dashboard styling)
- Supabase PostgreSQL (persistence)
- Zod (boundary validation)
- Vitest (unit + authorization tests)
- GitHub Actions (CI workflow)

## Prerequisites

- Node.js 22+
- pnpm 10+

## Quick start

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000. You will be redirected to `/login`.

The dashboard needs Supabase configured **and** a user to sign in as:

```bash
cp .env.example apps/web/.env.local   # then fill in the Supabase values
pnpm --filter @hextrail/web seed:user -- --email you@example.com --password 'choose-a-password'
```

Sign in with those credentials. The dashboard shows the projects that user
owns and the traces recorded against them.

## Authentication

Custom sessions — **not** Supabase Auth.

- `hx_users` stores bcrypt password hashes.
- `hx_sessions` stores opaque session rows. Only a SHA-256 hash of the token is
  persisted; the raw token lives in the `hx_session` cookie.
- The cookie is `httpOnly`, `SameSite=Lax`, and `Secure` in production, so it is
  not readable by client JavaScript.

### Authorization

There is no `auth.uid()` in this design, so **the database cannot scope a query
for us**. RLS is enabled on every `hx_` table with zero policies as a
default-deny backstop, and access is revoked from `anon`/`authenticated`. The
server is the security boundary.

Every read in `src/lib/queries/` therefore takes the authenticated user as its
first argument and applies two rules:

1. Resolve the project ids owned by that user (`hx_projects.owner_id`).
2. Constrain every trace and span query to that set.

A trace id belonging to another user matches zero rows and returns **404**, not
403 — a 403 would confirm the id exists.

## Commands

| Command           | What it does                                             |
| ----------------- | -------------------------------------------------------- |
| `pnpm dev`        | Start the Next.js dashboard (http://localhost:3000)      |
| `pnpm build`      | Production build of the web app                          |
| `pnpm lint`       | ESLint over the web app                                  |
| `pnpm typecheck`  | `tsc --noEmit` in every workspace package                |
| `pnpm test`       | Vitest unit tests in every workspace package             |
| `pnpm release:check` | Full release gate for `@hextrail/sdk`: builds, packs, inspects the tarball, scans for secrets, and installs + type-checks it in a clean external project |
| `pnpm release:check:quick` | Same gate without the external install (~20 s)    |
| `pnpm release:preview` | `npm pack --dry-run` — lists the files that would ship |

## Ingestion API

`POST /api/v1/traces` accepts a trace and its spans in one atomic write.

### Authentication

Project-scoped API keys, sent as a bearer token:

```
Authorization: Bearer hx_live_<key>
```

Only a SHA-256 hash of the key is stored (table `hx_api_keys`). The raw key is
shown once at creation and never persisted. A key resolves to exactly one
project; a `projectId` in the body is accepted only when it matches that
project, so a key cannot write into another project.

### Request

`Content-Type: application/json`, max 1 MB, max 500 spans per trace.

```json
{
  "schemaVersion": 1,
  "trace": {
    "traceId": "trc_abc123",
    "name": "support-assistant",
    "startedAt": "2026-10-15T10:00:00.000Z",
    "endedAt": "2026-10-15T10:00:01.240Z",
    "status": "ok",
    "environment": "production",
    "metadata": { "region": "eu-west-1" }
  },
  "spans": [
    {
      "spanId": "spn_1",
      "name": "llm.plan",
      "kind": "llm",
      "startedAt": "2026-10-15T10:00:00.100Z",
      "endedAt": "2026-10-15T10:00:00.400Z",
      "status": "ok",
      "attributes": { "model": "local" }
    }
  ]
}
```

`status` is `ok`, `error`, or `running`. `kind` is `agent`, `llm`, `tool`,
`retriever`, `chain`, or `custom`. Trace and spans may be `running` with no
`endedAt`.

### Responses

| Status | Meaning |
| --- | --- |
| 201 | Trace and spans created |
| 200 | Duplicate submission, original kept (`duplicate: true`) |
| 400 | Malformed JSON, or payload failed validation |
| 401 | Missing, invalid, or revoked API key |
| 403 | `projectId` in the body does not match the key's project |
| 413 | Payload larger than 1 MB |
| 429 | Rate limit exceeded. `Retry-After` and `X-RateLimit-*` headers are set |
| 503 | Rate limiter unavailable (fails closed) |
| 500 | Persistence failure |

### Idempotency

Resubmitting the same `(project, traceId)` is a no-op: the original trace and
its spans are preserved and the response is `200` with `duplicate: true`.

### Atomicity

The trace and all spans are written by the `hx_ingest_trace` Postgres function
in a single transaction. A failure part-way through never leaves a trace with
missing spans.

### Verified behaviour (live, against Postgres)

Exercised over real HTTP with a real API key against a real Supabase project —
not mocked:

| Check | Result |
| --- | --- |
| Valid payload | `201` with a trace UUID |
| Resubmit same `(project, traceId)` | `200`, `duplicate: true`, **1 row** in `hx_traces` |
| Credential-shaped metadata | stored as `[REDACTED]`, including nested `password` |
| Credential-shaped span attribute | stored as `[REDACTED]` |
| `projectId` mismatching the key | `403` |
| No `Authorization` header | `401` |
| Invalid key | `401` |
| Missing `schemaVersion` | `400` with a field-level `details` entry |
| Atomic consume, sequential | limit `2` → allowed, allowed, blocked, blocked |
| Atomic consume, **30 parallel calls**, limit `10` | exactly **10** allowed |

The concurrency row is the one that matters: it is what proves the limiter is
atomic rather than read-then-write. A naive implementation lets a burst through.

### Verified behaviour — dashboard (live, against Postgres)

| Check | Result |
| --- | --- |
| `POST /api/auth/login` with valid credentials | `200`, `httpOnly` session cookie set |
| Login with a wrong password | `401`, identical message to an unknown email |
| Dashboard route with no cookie | `307` to `/login?next=…` |
| Detail API with no cookie | `401` |
| Detail API with a bogus cookie | `401` |
| Detail API for a trace owned by another user | `404` (not `403`) |
| Detail API for a malformed id | `404` (never a `500` from Postgres) |
| Trace ingested via `POST /api/v1/traces` | appears in the project's trace list and overview |
| Trace detail | fields, spans with computed offsets, and the span error object all render |
| Redaction | survives into the dashboard payload as `[REDACTED]` |
| Pagination (`?limit=2`) | 2 rows, newest first, "Load more" rendered |
| Unknown `?project=` id | falls back to all owned projects; no query uses the id |

## API key management

### TypeScript SDK

`packages/sdk` publishes as `@hextrail/sdk`. It is the supported way for an
external agent to send traces — see `packages/sdk/README.md` for the full guide.

```ts
import { HextrailClient, type TraceEnvelope } from "@hextrail/sdk";

const hextrail = new HextrailClient({
  apiKey: process.env.HEXTRAIL_API_KEY!,
  // Omit for Hextrail Cloud; point at localhost during development.
  endpoint: "http://localhost:3000/api/v1/traces",
});

const payload: TraceEnvelope = { schemaVersion: 1, trace: { /* ... */ }, spans: [] };
await hextrail.ingestTrace(payload);
```

Design points worth knowing:

- **Zero runtime dependencies.** It runs inside someone else's agent process, so
  it brings nothing with it. Node 18+, Bun, Deno, and Workers are all supported.
- **Retries are safe because ingestion is idempotent.** Network errors,
  timeouts, `429` and `5xx` are retried; `400`, `401`, `403` and `413` are not,
  because resending an identical bad request cannot help.
- **`Retry-After` is honoured**, with exponential backoff and full jitter as the
  fallback.
- **Errors carry no secrets.** `HextrailError` holds a status, a code, a
  server-supplied message, and validation details — never the API key, and
  never the request body.

Session-authenticated endpoints behind `/settings`. Distinct from
`POST /api/v1/traces`, which is the SDK surface and authenticates with a bearer
key.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/keys` | List the user's keys — prefix and metadata only |
| `POST` | `/api/keys` | Create a key for an owned project; returns the raw key **once** |
| `DELETE` | `/api/keys/[keyId]` | Revoke a key. Idempotent |

### Key format and storage

`hx_live_` followed by 32 bytes from a CSPRNG, base64url-encoded — 51
characters, 256 bits of entropy. `Math.random` is never used, so keys cannot be
predicted from one another.

Only the SHA-256 hash and a 12-character display prefix are stored. The raw key
exists in memory for the duration of one request and is returned exactly once:
it is never logged, never written to browser storage, and never placed in a
URL. A database leak therefore does not hand over usable credentials.

SHA-256 without a salt is correct *here* because the input is uniformly random
— there is no dictionary to attack, unlike a password. That is precisely why
passwords use bcrypt and keys do not. Both use the same shared contract:
`hashApiKey` in `src/lib/ingestion/auth.ts` is the single source of truth, so
the creation path and the authentication path cannot drift apart.

### Authorization

Every operation takes the authenticated session user and derives allowed
project ids from `hx_projects.owner_id`. A project id supplied by the client is
never trusted on its own. A key or project belonging to another user returns
`404`, not `403` — a `403` would confirm the id exists, which is the oracle an
attacker probing ids wants.

Revocation is **immediate**: `authenticateApiKey` filters on
`revoked_at is null`, and there is no cached key or token to expire. The next
request with a revoked key fails. Revoking twice succeeds without rewriting the
original timestamp.

### Verified behaviour — key management (live, against Postgres)

| Check | Result |
| --- | --- |
| `GET`/`POST`/`DELETE` with no session | `401`, no query runs |
| Create with a valid project and name | `201`, 51-character key, `no-store` + `no-cache` headers |
| Create response `prefix` vs `rawKey` | prefix is a true prefix of the raw key |
| Ingest using the **newly created** key | `201` |
| Ingest using that key **after revoke** | `401` |
| Revoke a second time | `200`, same `revokedAt` as the first |
| Create for a project id the user does not own | `404` |
| Revoke with a malformed id | `404`, never a `500` from Postgres |
| Revoke an unknown-but-valid uuid | `404` |
| Another user lists keys | `200`, empty — the owner's keys are not visible |
| Another user revokes the owner's key | `404`, and the key stays live |
| Another user mints a key for the owner's project | `404` |
| Owner's key after those attempts | untouched, still authenticates |
| Revoked key in the list | shown with `revokedAt`, all hashes absent |
| `/settings` HTML and client chunks | no hash, no raw key, no service-role key |

### curl

```bash
curl -X POST http://localhost:3000/api/v1/traces \
  -H "Authorization: Bearer $HEXTRAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "schemaVersion": 1,
    "trace": {
      "traceId": "trc_abc123",
      "name": "support-assistant",
      "startedAt": "2026-10-15T10:00:00.000Z",
      "endedAt": "2026-10-15T10:00:01.240Z",
      "status": "ok"
    },
    "spans": []
  }'
```

### Creating a project and a key

There is no UI yet. Insert directly, storing only the SHA-256 hash of the key:

```sql
insert into public.hx_projects (owner_id, name, description)
values ('<your-user-uuid>', 'My Agent', 'What this project records');

insert into public.hx_api_keys (project_id, name, key_hash, key_prefix)
values (
  '<project-uuid>',
  'local-dev',
  encode(digest('hx_live_replace_me_with_a_long_random_string', 'sha256'), 'hex'),
  'hx_live_repl'
);
```

Generate the key value yourself (at least 32 characters, prefixed `hx_live_`).
Keep the raw value; only the hash goes in the database. `key_prefix` must be
8–16 characters — it is the only part ever displayed.

## Workspace

- `apps/web`: Next.js dashboard, ingestion API, session auth, and read queries.
  - `src/lib/auth/`: password hashing, sessions, cookie name
  - `src/lib/queries/`: session-scoped reads and row-to-view-model mappers
  - `src/lib/ingestion/`: payload validation, redaction, rate limiting
  - `src/app/api/auth/`: sign-in and sign-out
- `packages/sdk`: the published `@hextrail/sdk` — wire types, a typed ingestion
  client, and `getDurationMs`. Zero runtime dependencies. Built to `dist/` with
  declarations; see `packages/sdk/README.md`.
- `supabase/migrations`: SQL schema. Run `0002`, `0003` and `0004` in order;
  `0001` is a superseded record and must not be run.
- `.github/workflows/ci.yml`: CI pipeline (typecheck → lint → test → build).

## Environment

Copy `.env.example` to `.env.local` when configuring Supabase. Never commit service-role keys or ingestion secrets.

| Variable | Where | Purpose | Required today |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Browser | Supabase project URL. Read by `src/lib/supabase/service.ts` | Only for ingestion |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server only** | Privileged key for `POST /api/v1/traces`. Bypasses RLS — must never reach the browser, and must never take a `NEXT_PUBLIC_` prefix | Only for ingestion |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser | Reserved for future auth. Not read by any code | No |
| `HEXTRAIL_INGESTION_SECRET` | Server only | Reserved. Not read by any code — the endpoint uses project API keys | No |
| `HEXTRAIL_RATE_LIMIT` | Server only | Requests allowed per window, per API key. Defaults to `600` | No |
| `HEXTRAIL_RATE_WINDOW_SECONDS` | Server only | Length of the rate-limit window in seconds. Defaults to `60` | No |
| `HEXTRAIL_RATE_LIMIT_STORE` | Server only | Set to `memory` for a per-process limiter. **Local development only** — never distributed, never production | No |
| `TEST_SUPABASE_URL` | Server only | Isolated test project, enables integration tests | No |
| `TEST_SUPABASE_SERVICE_ROLE_KEY` | Server only | Isolated test project key, enables integration tests | No |
| `HEXTRAIL_TEST_ENDPOINT` | Test only | Enables the SDK's live integration tests. Set with the next variable or the suite is skipped | No |
| `HEXTRAIL_TEST_API_KEY` | Test only | `hx_live_` key for the SDK's live integration tests. Never point at production | No |

`SUPABASE_SERVICE_ROLE_KEY` is required for the ingestion endpoint, the
dashboard, and session validation. Without it the app returns an error state
rather than failing open.

## Known limitations

- No sign-up. Users are created with `seed:user` or SQL.
- No project creation UI. Projects are inserted with SQL.
- API keys can be created and revoked from `/settings`, but not renamed, and
  there is no automatic rotation or expiry. Rotating means creating a new key,
  deploying it, then revoking the old one.
- The overview metrics aggregate over at most the 100 most recent traces in the
  window, not the full history. An exact figure needs a SQL aggregate.
- The trace list has no exact total, so it shows "Showing N" rather than
  "N of M".
- Time range and project selection are URL parameters; there is no persisted
  user preference, so they reset to defaults on a fresh visit.
- Traces are read-only in the dashboard. There is no delete, export, or search
  across span attributes.
- The SDK is **built and packaged** (`pnpm build:sdk`, verified by installing the
  tarball into a project outside the monorepo) but **not published to npm**. No
  registry credentials have been used. See the release blockers below.
- CI was added but has not run on GitHub yet (no remote repository configured).
- The dashboard has no automated UI tests. Component behaviour is verified
  manually; the query, authorization, API-key and route layers are covered by
  unit tests.

### Redaction is not PII detection

`src/lib/ingestion/redact.ts` masks values whose **key name** looks like a
credential (`password`, `api_key`, `authorization`, `access_token`, …), plus a
small set of high-confidence value shapes (bearer tokens, JWTs, AWS and GitHub
keys, private key blocks). It runs before anything is persisted.

It does **not** understand content. A secret under an innocent key name
(`notes`, `context`, `input`) is stored verbatim, and personal data — names,
emails, addresses — is not detected at all. Do not call this "PII-safe" and do
not treat stored traces as safe to share.

### Rate limiting is fixed-window

`hx_rate_limit_consume` (migration `0004`) enforces a fixed window in Postgres,
so the limit holds across serverless instances and survives cold starts.
Consequence: a client can send up to **2x** the limit across a window boundary.
Move to a sliding window (Redis/Upstash) if boundary bursts matter — the
`RateLimitStore` interface exists so that is a drop-in swap.

The limiter **fails closed**: if Postgres is unreachable, ingestion returns
`503` rather than allowing an unbounded stream.

### Integration tests are skipped by default

`src/lib/ingestion/ingestion.integration.test.ts` writes real rows and deletes
them afterwards. It runs only when both `TEST_SUPABASE_URL` and
`TEST_SUPABASE_SERVICE_ROLE_KEY` are set **and** the test URL differs from
`NEXT_PUBLIC_SUPABASE_URL`. Without them, Vitest reports those tests as
**skipped**, never as passed.

The dashboard's query layer is covered by unit tests with a mocked Supabase
client (see `src/lib/queries/authorization.test.ts`). Those tests assert what
the query *asks for* — that `owner_id` is always in the filter, that an unowned
project produces no trace query at all, that a foreign trace returns `not_found`
and never loads spans. They do not exercise a live database.

## Publishing the SDK

**Not published.** Nothing here has been pushed to a registry, and the
release workflow is deliberately inert.

Release engineering exists and is verified locally. Publishing is blocked on
account and DNS state, not on code. The full procedure is in
[`docs/RELEASING.md`](docs/RELEASING.md).

### What exists

| Piece | State |
|---|---|
| `.github/workflows/ci.yml` | PR/push CI: typecheck, lint, tests, contract check, web build, package gate. No secrets — safe for forks. |
| `.github/workflows/release-sdk.yml` | Publish via npm Trusted Publishing (OIDC). **Manual-dispatch only**; the tag trigger is commented out. |
| `scripts/release-check.mjs` | 60-check release gate against the real tarball. Exit 0 = releasable. |
| `docs/RELEASING.md` | Prerequisites, triggers, rollback, and the endpoint decision. |

### Local verification

```bash
# Builds the SDK, packs the tarball npm would upload, inspects its contents,
# scans for credentials, installs it into a clean npm project outside the
# monorepo, and type-checks that consumer with skipLibCheck: false.
pnpm release:check
```

### Triggering a release

Actions → **Release SDK** → **Run workflow** → type `publish`. The run then
pauses at the `npm-release` environment for human approval.

No npm token is used. `id-token: write` is granted only to the publish job, and
npm exchanges the OIDC token for publish rights. **Do not add `NPM_TOKEN`.**

Nothing may be published until the prerequisites in `docs/RELEASING.md` §1–§4
are complete.

### Release blockers

Blockers 4 and 5 from the previous revision are resolved by the CI workflow:
the publish path now runs the **whole** workspace suite (including the
`apps/web` contract assertion) before publishing, and publishes with
`--provenance` over OIDC. `prepublishOnly` still covers only the SDK, so it
remains a weaker path than the workflow — prefer the workflow.

What remains:

1. **The npm scope does not exist.** `@hextrail/sdk` returns 404 and there is no
   `hextrail` organisation — re-verified. Claiming the scope is a one-time
   manual step (`docs/RELEASING.md` §1).
2. **The repository is not on GitHub.** CI and Trusted Publishing are configured
   but have never executed. Until the repo is pushed, every workflow result is
   unverified — the local checks below are not a substitute.
3. **No GitHub Environment `npm-release`** with required reviewers. Without it
   the publish job cannot start (`docs/RELEASING.md` §2.3).
4. **No Trusted Publisher configured on npm** (`docs/RELEASING.md` §3).
5. **The ingest host does not resolve.** Verified independently:
   `Resolve-DnsName ingest.hextrail.ai` → *DNS name does not exist*. The apex
   `hextrail.ai` does not resolve either, so no part of the domain is live.
   `DEFAULT_ENDPOINT` (`https://ingest.hextrail.ai/api/v1/traces`) is therefore
   currently a host that fails at first ingest. Resolve it before publishing, or
   make `endpoint` required so the failure is a clear config error instead of a
   network error. `release:check` reports this as a warning — it will not stop a
   publish, so it is a human decision.
6. **Version is `0.1.0` and the API is not frozen.** `TraceEnvelope` is treated
   as append-only from here; publishing fixes it. Worth a deliberate review of
   the payload contract first.

## Project status

- [x] Monorepo and TypeScript foundation
- [x] Initial trace/span contract
- [x] SQL schema (`0002`), applied
- [x] Unit tests for the SDK
- [x] CI workflow: typecheck, lint, tests, contract check, web build, package gate (never executed on GitHub)
- [x] API-key-protected ingestion endpoint (`0003`), applied
- [x] Durable trace ingestion — verified live over HTTP against Postgres
- [x] Redaction of credential-shaped fields, applied at ingestion
- [x] Distributed rate limiting (`0004`), applied
- [x] Custom session authentication — login, logout, hashed session tokens
- [x] Authorization on every read, scoped by project ownership
- [x] Dashboard reads persisted traces — list, detail, spans, errors, metrics
- [x] Loading, empty, error, retry, unauthorized and not-found states
- [x] Bounded cursor pagination with stable ordering
- [x] API key management — create, list, revoke; one-time secret display
- [x] SDK built, packaged, and installed from a tarball outside the monorepo
- [x] Bidirectional SDK↔server contract assertion (fails the build on drift)
- [x] Release gate — 60 checks against the real tarball; secrets, fixtures and workspace deps excluded (verified locally)
- [x] Publish workflow on npm Trusted Publishing over OIDC, gated on approval (never executed)
- [ ] Sign-up flow
- [ ] Project creation UI
- [ ] Exact totals and full-history aggregates
- [ ] SDK published to npm
- [ ] Integration suite running in CI against an isolated test project
- [ ] End-to-end auth/layout fix — signed-out users currently still see the app shell

Do not use this project to ingest real prompts, secrets, or production
telemetry. Redaction reduces accidental credential leakage; it is not PII
detection and stored traces are not safe to share.

## License

MIT — see `LICENSE`.
