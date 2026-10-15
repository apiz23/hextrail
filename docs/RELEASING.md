# Releasing `@hextrail/sdk`

**Status: not published. Nothing in this document has been executed.**

This is the runbook for publishing the SDK to npm with Trusted Publishing
(GitHub Actions OIDC). It exists so the release is a repeatable procedure rather
than a sequence of remembered commands.

Nothing here has been run. Everything in §1–§4 is a prerequisite that a human
must complete before the workflow can publish anything.

---

## 0. Current blockers

None of these are code problems. All are account/infrastructure state.

| # | Blocker | Where it is resolved |
|---|---|---|
| 1 | The `@hextrail` npm scope does not exist | npmjs.com — §1 |
| 2 | The repository is not on GitHub, so there are no Actions | §2 |
| 3 | No GitHub Environment `npm-release` with required reviewers | §2 |
| 4 | No Trusted Publisher configured on the npm package | §3 |
| 5 | `DEFAULT_ENDPOINT` (`https://ingest.hextrail.ai/api/v1/traces`) does not resolve | §5 |
| 6 | The wire contract is not frozen; version is `0.1.0` | §6 |

---

## 1. Claim the npm scope

The `@hextrail` scope returns 404 — it is unclaimed, and the `hextrail`
organisation does not exist.

1. Sign in to npmjs.com.
2. Create the organisation `hextrail`, **or** publish a package under the scope
   from a personal account (which claims the scope implicitly).
3. If creating an org, set the package access to **public** — the SDK is MIT and
   must be installable without a paid plan.

Verify:

```bash
npm view @hextrail/sdk version   # expect: 404 Not Found (unpublished, scope claimed)
```

A 404 on the *package* is correct. A 404 on `@hextrail` as a scope means §1 is
not done.

---

## 2. Repository settings on GitHub

### 2.1 Push the repository

The project is not currently a git repository. Initialise it, commit, and push
to GitHub before any of this is meaningful.

Confirm before the first push that no secret is staged:

```bash
git status --porcelain | grep -E '\.env' # must not list apps/web/.env.local
```

`.gitignore` already excludes `.env`, `.env.local`, `.env.*.local`,
`.env.production`, `.env.development`, and `.env.test`. `.env.example` is
deliberately kept.

### 2.2 Branch protection on `main`

Require the CI workflow to pass before merge. Required status checks:

| Check name | Job |
|---|---|
| `Typecheck, lint, tests` | `ci.yml` → `quality` |
| `SDK/server schema contract` | `ci.yml` → `contract` |
| `Next.js production build` | `ci.yml` → `build-web` |
| `Package build and tarball inspection` | `ci.yml` → `package` |

Require these on PRs **and** on direct pushes to `main`. A tag taken from an
unverified commit is the failure mode this prevents.

### 2.3 Create the release environment

The publish job is bound to a GitHub Environment named **`npm-release`**. Until
that environment exists, the job cannot run.

1. Repository → **Settings** → **Environments** → **New environment**.
2. Name it exactly `npm-release`.
3. Enable **Required reviewers** and add at least one person.
4. Leave "Prevent self-review" on if the release should require a second person.

This is the human gate. npm Trusted Publishing proves *which workflow* is
publishing; the environment proves *a person approved it*.

### 2.4 Repository secrets

**None.** That is the point of Trusted Publishing.

Do not add `NPM_TOKEN` or `NPM_AUTH_TOKEN`. If one exists, delete it: a
long-lived token bypasses the OIDC exchange and re-introduces the credential the
setup exists to remove.

The PR CI workflow holds no secrets at all, which is what makes it safe to run
on pull requests from forks.

---

## 3. Configure the Trusted Publisher on npm

Do this **after** §1 (scope) and §2 (repository exists).

1. npmjs.com → the `@hextrail/sdk` package page → **Settings** →
   **Trusted Publisher**.
2. Choose **GitHub Actions** and fill in:

| Field | Value |
|---|---|
| Organization / User | the GitHub owner (org or user) |
| Repository | the repository name |
| Workflow filename | `release-sdk.yml` |
| Environment | `npm-release` |

The environment field must match the `environment.name` in
`.github/workflows/release-sdk.yml`. A mismatch makes the OIDC exchange fail.

3. Leave the package's publishing access as **public**.

Requirements verified against the workflow:

- npm CLI **≥ 11.5.1** — the publish job runs `npm install --global npm@latest`
  because Node 22's bundled npm is older. Publishing with an older CLI fails
  even when everything else is correct.
- Workflow permission **`id-token: write`** — granted only to the `publish` job.
- The workflow must run on GitHub-hosted runners (it does: `ubuntu-latest`).

---

## 4. Triggering a release

The workflow is **manual-dispatch only**. The tag trigger is present but
commented out, so an accidental `git push --tags` cannot publish.

### 4.1 Before triggering

1. Bump `version` in `packages/sdk/package.json`.
2. Update the release notes in `packages/sdk/README.md`.
3. Confirm CI is green on the exact commit you intend to release.
4. Run the local gate:

```bash
pnpm release:check
```

5. Inspect exactly what would ship, without packing a tarball:

```bash
pnpm release:preview
```

6. Confirm the version is unpublished:

```bash
npm view @hextrail/sdk versions
```

### 4.2 Triggering

Actions → **Release SDK** → **Run workflow** → type `publish` in the
confirmation field → run.

The workflow then:

1. Verifies the confirmation input.
2. Installs with a frozen lockfile.
3. Typechecks, lints, and runs **all** tests — including `apps/web`.
4. Verifies the SDK/server contract.
5. Runs `scripts/release-check.mjs` against the real tarball.
6. Pauses at the `npm-release` environment for a human approval.
7. Re-checks that the version is unpublished.
8. Publishes with `--provenance --access public` and no token.

### 4.3 After publishing

1. Confirm the provenance attestation shows on the npm package page.
2. Install the published version in a project outside the monorepo:

```bash
npm install @hextrail/sdk@<version>
```

3. Create the git tag and GitHub release, if tags are used:

```bash
git tag sdk-v<version>
git push origin sdk-v<version>
```

This does **not** re-trigger publishing while the `push.tags` trigger stays
commented out. If it is ever uncommented, the version check in the publish job
still refuses to republish an existing version.

---

## 5. Endpoint: unverified, and why it matters

`DEFAULT_ENDPOINT` is `https://ingest.hextrail.ai/api/v1/traces`. **This host
does not resolve.** DNS is not configured and no ingestion host is provisioned.

Publishing with this default makes a host nobody has verified the default for
every consumer: a developer who constructs the client without passing `endpoint`
gets a DNS failure at first ingest with nothing in the message explaining why.

Two acceptable resolutions before publishing:

1. **Provision the host** — point `ingest.hextrail.ai` at the deployed ingestion
   API over HTTPS, and verify with
   `curl -sS -o /dev/null -w '%{http_code}' https://ingest.hextrail.ai/api/v1/traces`
   (expect `401`/`405` for an unauthenticated `GET`, not a connection error).
2. **Remove the default** — make `endpoint` a required option so the failure is
   a clear configuration error at construction time rather than a network error
   at first use.

Either is fine. Publishing while the default resolves nowhere is not.

The `release:check` script reports this as a warning and fails nothing, so it
will not stop a publish. It is a judgement call a person has to make.

---

## 6. Version and contract stability

The SDK is `0.1.0`. A `0.x` version is the correct signal: the wire contract has
not been frozen, and minor versions may break.

Before `1.0.0`:

- Add a documented compatibility policy for `TraceEnvelope` and `SpanRecord`.
- Decide what a schema change means — additive-only, or a `SCHEMA_VERSION` bump.
- Keep the `schema.ts` contract assertion in `apps/web` as the enforcement
  mechanism; it is what turns a breaking drift into a build failure.

The `prepublishOnly` script runs `release-check.mjs --skip-install`, so a manual
`npm publish` cannot ship an unbuilt or misconfigured artifact. **It does not
run `apps/web`'s contract tests** — that is deliberate, because a bare
`npm publish` from `packages/sdk` should not require the whole monorepo to be
installed. The GitHub workflow covers the gap by running the contract check
before the publish job. Prefer the workflow over a manual publish.

---

## 7. Local release commands

| Command | Does | Time |
|---|---|---|
| `pnpm release:check` | Full gate: builds, packs, inspects the tarball, scans for secrets, installs into a clean npm project, typechecks it with `skipLibCheck: false` | ~1–2 min |
| `pnpm release:check:quick` | Same minus the external install and typecheck | ~20 s |
| `pnpm release:preview` | `npm pack --dry-run` — lists the files that would ship | ~5 s |

`release:check` writes to a temp directory and removes it. Pass `--keep` to
inspect the tarball and consumer project afterwards:

```bash
node scripts/release-check.mjs --keep
```

Exit code `0` means releasable. Any other exit code means do not publish.
