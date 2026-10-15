#!/usr/bin/env node
/**
 * Release gate for `@hextrail/sdk`.
 *
 * Asserts everything that must be true before `npm publish` that the test suite
 * cannot see. Tests prove the code works; this proves the *artifact* is
 * correct â€” that the package points at real files, ships no secrets or test
 * files, declares no workspace-only dependencies, and installs and type-checks
 * from a tarball in a clean project.
 *
 * Every check runs against the tarball npm would actually upload, not against
 * the working tree. That distinction matters: `files`, `exports`, and the
 * `dist/` layout are all interpreted by npm, and a tarball is the only thing
 * that shows the result.
 *
 * Exit code 0 = releasable. Anything else = do not publish.
 *
 * Usage:
 *   node scripts/release-check.mjs [--keep] [--skip-install]
 *
 *   --keep          Leave the temp directory in place for inspection.
 *   --skip-install  Skip the external-consumer install and type-check. Faster,
 *                   but skips the single most valuable check. CI must not use
 *                   this.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SDK_DIR = join(REPO_ROOT, "packages", "sdk");

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const SKIP_INSTALL = args.includes("--skip-install");

/* -------------------------------------------------------------------------- */
/* Reporting                                                                   */
/* -------------------------------------------------------------------------- */

let failures = 0;
let warnings = 0;
const results = [];

const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const YELLOW = "\u001b[33m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

function ok(label, detail = "") {
  results.push({ level: "ok", label, detail });
  console.log(`${GREEN}PASS${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ""}`);
}

function fail(label, detail = "") {
  failures++;
  results.push({ level: "fail", label, detail });
  console.log(`${RED}FAIL${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ""}`);
}

function warn(label, detail = "") {
  warnings++;
  results.push({ level: "warn", label, detail });
  console.log(`${YELLOW}WARN${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ""}`);
}

function section(title) {
  console.log(`\n${DIM}--- ${title} ---${RESET}`);
}

function check(condition, label, detail = "") {
  if (condition) ok(label, detail);
  else fail(label, detail);
  return condition;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // Windows resolves `pnpm`/`npm` to `.cmd` shims, which cannot be spawned
    // directly (EINVAL) — only a shell can run them. So `shell: true` is used
    // *only* for a resolved `.cmd`/`.bat` on Windows, and never combined with
    // interpolated input: every argument passed in this script is a literal or
    // a path this script created, so there is nothing for a shell to misread.
    // On POSIX (including CI) this is always false and args stay a real array.
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
    ...options,
  });
}

/**
 * Resolves a package-manager binary to something spawnable without a shell.
 *
 * On Windows `npm` is `npm.cmd`; spawning it directly works, whereas
 * `shell: true` would go through cmd.exe and re-introduce escaping problems.
 */
function resolveBin(name) {
  if (process.platform !== "win32") return name;
  return `${name}.cmd`;
}

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * A tarball entry name is `package/<path>`. Normalise to the repo-relative
 * form so messages point at something a human can find.
 */
function tarballRoot(entry) {
  return entry.replace(/^package\//, "");
}

let tempRoot = null;

function cleanup() {
  if (tempRoot && !KEEP) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

/* -------------------------------------------------------------------------- */
/* 1. Package metadata                                                         */
/* -------------------------------------------------------------------------- */

section("package metadata");

const pkgPath = join(SDK_DIR, "package.json");
if (!existsSync(pkgPath)) {
  fail("packages/sdk/package.json exists");
  console.log("\nCannot continue without a package manifest.");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

check(
  typeof pkg.name === "string" && pkg.name.startsWith("@"),
  "name is a scoped package",
  pkg.name,
);

check(
  pkg.private !== true,
  "not marked private (would block publish)",
  pkg.private === undefined ? "private unset" : "private=true",
);

// A version npm will accept: semver, no build metadata, no leading v.
const versionOk = typeof pkg.version === "string" && /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(pkg.version);
check(versionOk, "version is valid semver", pkg.version);

check(pkg.license === "MIT", "license declared", pkg.license);

// `workspace:*` in a published dependency is the classic pnpm publish failure:
// it either fails to resolve for consumers or silently rewrites to a version
// that does not exist on the registry.
const allDeps = { ...(pkg.dependencies ?? {}) };
const workspaceRefs = Object.entries(allDeps).filter(([, v]) =>
  String(v).includes("workspace:"),
);
check(
  workspaceRefs.length === 0,
  "no workspace: dependencies in the published manifest",
  workspaceRefs.length ? workspaceRefs.map(([k, v]) => `${k}@${v}`).join(", ") : "none",
);

check(
  Object.keys(allDeps).length === 0,
  "zero runtime dependencies",
  Object.keys(allDeps).length ? Object.keys(allDeps).join(", ") : "none",
);

check(
  typeof pkg.engines?.node === "string",
  "engines.node declared",
  pkg.engines?.node ?? "missing",
);

check(pkg.publishConfig?.access === "public", "publishConfig.access is public", pkg.publishConfig?.access ?? "missing");

/* -------------------------------------------------------------------------- */
/* 2. Documentation and legal files                                            */
/* -------------------------------------------------------------------------- */

section("documentation and license");

function requireNonEmptyFile(path, label, minBytes = 1) {
  if (!existsSync(path)) return fail(label, "missing");
  const size = statSync(path).size;
  if (size < minBytes) return fail(label, `too small (${size} bytes)`);
  return ok(label, `${size} bytes`);
}

requireNonEmptyFile(join(SDK_DIR, "README.md"), "packages/sdk/README.md present", 500);
requireNonEmptyFile(join(SDK_DIR, "LICENSE"), "packages/sdk/LICENSE present", 100);

const sdkReadme = existsSync(join(SDK_DIR, "README.md"))
  ? readFileSync(join(SDK_DIR, "README.md"), "utf8")
  : "";

// A README that never says how to install is not an install guide.
check(/npm install|pnpm add|yarn add/.test(sdkReadme), "README documents installation");
check(/HextrailClient/.test(sdkReadme), "README documents the client");

/* -------------------------------------------------------------------------- */
/* 3. Build the package                                                        */
/* -------------------------------------------------------------------------- */

section("build");

// A stale dist/ would make every check below meaningless, so clear it.
rmSync(join(SDK_DIR, "dist"), { recursive: true, force: true });

try {
  run(resolveBin("pnpm"), ["run", "build"], { cwd: SDK_DIR });
  ok("pnpm run build (clean dist)");
} catch (error) {
  fail("pnpm run build", String(error.stdout ?? error.message).slice(0, 400));
  console.log("\nBuild failed. Nothing else can be verified.");
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* 4. exports map resolves to real files                                       */
/* -------------------------------------------------------------------------- */

section("exports map");

/**
 * Walks the `exports` field and asserts every referenced path exists in dist.
 * A typo here is invisible locally (the workspace resolves through pnpm
 * symlinks) and fatal for a consumer.
 */
function collectExportPaths(exportsField) {
  const paths = [];
  if (typeof exportsField === "string") {
    paths.push(exportsField);
    return paths;
  }
  if (exportsField && typeof exportsField === "object") {
    for (const value of Object.values(exportsField)) {
      paths.push(...collectExportPaths(value));
    }
  }
  return paths;
}

const exportPaths = collectExportPaths(pkg.exports).filter(
  // `./package.json` points at the manifest itself, not dist.
  (p) => p !== "./package.json",
);

check(exportPaths.length > 0, "exports map is non-empty", `${exportPaths.length} entries`);

for (const exportPath of exportPaths) {
  const resolved = join(SDK_DIR, exportPath);
  check(existsSync(resolved), `exports target exists: ${exportPath}`);
}

check(
  typeof pkg.main === "string" && existsSync(join(SDK_DIR, pkg.main)),
  "main resolves to a real file",
  pkg.main,
);
check(
  typeof pkg.types === "string" && existsSync(join(SDK_DIR, pkg.types)),
  "types resolves to a real file",
  pkg.types,
);

/* -------------------------------------------------------------------------- */
/* 5. declarations are real, non-empty, and complete                           */
/* -------------------------------------------------------------------------- */

section("type declarations");

const distDir = join(SDK_DIR, "dist");
const distFiles = existsSync(distDir) ? listFilesRecursive(distDir) : [];

const dtsFiles = distFiles.filter((f) => f.endsWith(".d.ts"));
check(dtsFiles.length > 0, "declaration files emitted", `${dtsFiles.length} .d.ts`);

for (const dts of dtsFiles) {
  const content = readFileSync(dts, "utf8");
  const name = relative(SDK_DIR, dts);
  check(content.trim().length > 0, `declaration not empty: ${name}`);
}

// Source maps must reference the source they came from, or debuggability is
// a lie. declarationMap is what makes "go to definition" land in real code.
const dtsMaps = distFiles.filter((f) => f.endsWith(".d.ts.map"));
check(dtsMaps.length === dtsFiles.length, "every declaration has a declaration map", `${dtsMaps.length}/${dtsFiles.length}`);

// The public surface must actually export something.
const indexDts = join(distDir, "index.d.ts");
if (existsSync(indexDts)) {
  const indexContent = readFileSync(indexDts, "utf8");
  check(/export/.test(indexContent), "index.d.ts exports a public surface");
  for (const symbol of ["HextrailClient", "HextrailError", "TraceEnvelope"]) {
    check(
      indexContent.includes(symbol),
      `public surface includes ${symbol}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 6. the required subpath still works                                         */
/* -------------------------------------------------------------------------- */

section("subpath exports");

const schemaDts = join(distDir, "schema.d.ts");
if (check(existsSync(schemaDts), "dist/schema.d.ts exists (the /schema subpath)")) {
  const schemaContent = readFileSync(schemaDts, "utf8");
  check(/SCHEMA_VERSION/.test(schemaContent), "schema subpath exports SCHEMA_VERSION");
  check(/TRACE_STATUSES/.test(schemaContent), "schema subpath exports TRACE_STATUSES");
}

/* -------------------------------------------------------------------------- */
/* 7. pack the tarball                                                         */
/* -------------------------------------------------------------------------- */

section("tarball");

tempRoot = mkdtempSync(join(tmpdir(), "hextrail-release-check-"));
const packDir = join(tempRoot, "pack");
mkdirSync(packDir, { recursive: true });

let tarballPath = null;
try {
  const packOutput = run(resolveBin("npm"), ["pack", "--json", "--pack-destination", packDir], { cwd: SDK_DIR });
  const parsed = JSON.parse(packOutput);
  const file = parsed?.[0]?.filename;
  if (!file) throw new Error("npm pack --json returned no filename");
  tarballPath = join(packDir, file);
  ok("npm pack produced a tarball", file);
} catch (error) {
  fail("npm pack", String(error.stdout ?? error.message).slice(0, 400));
}

if (tarballPath && existsSync(tarballPath)) {
  const entries = run("tar", ["-tzf", tarballPath])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const files = entries.filter((e) => !e.endsWith("/")).map(tarballRoot);
  ok("tarball file count", `${files.length} files`);

  /* --- contents allowlist ------------------------------------------------- */

  // Only these should ship. Anything else is either a leak or dead weight.
  const allowedPrefixes = ["dist/"];
  const allowedExact = ["package.json", "README.md", "LICENSE"];
  const unexpected = files.filter(
    (f) =>
      !allowedExact.includes(f) && !allowedPrefixes.some((p) => f.startsWith(p)),
  );
  check(
    unexpected.length === 0,
    "tarball contains only dist/, README.md, LICENSE, package.json",
    unexpected.length ? unexpected.join(", ") : `${files.length} expected files`,
  );

  /* --- no tests, fixtures, or source -------------------------------------- */

  const testPatterns = [
    /\.test\.[cm]?[jt]sx?$/,
    /\.spec\.[cm]?[jt]sx?$/,
    /(^|\/)__tests__\//,
    /(^|\/)__mocks__\//,
    /(^|\/)fixtures?\//,
    /(^|\/)test\//,
    /(^|\/)tests\//,
  ];
  const testFiles = files.filter((f) => testPatterns.some((p) => p.test(f)));
  check(
    testFiles.length === 0,
    "no test files or fixtures in the tarball",
    testFiles.length ? testFiles.join(", ") : "none",
  );

  // TypeScript sources must not ship: dist/ is the artifact, and shipping both
  // invites consumers to import internals that are not part of the contract.
  const sourceFiles = files.filter(
    (f) => /\.tsx?$/.test(f) && !f.endsWith(".d.ts") && !f.endsWith(".d.ts.map"),
  );
  check(
    sourceFiles.length === 0,
    "no TypeScript source in the tarball",
    sourceFiles.length ? sourceFiles.join(", ") : "none",
  );

  check(
    files.some((f) => f === "package.json"),
    "tarball includes package.json",
  );
  check(files.some((f) => f === "README.md"), "tarball includes README.md");
  check(files.some((f) => f === "LICENSE"), "tarball includes LICENSE");

  // The web app must never leak into the SDK artifact.
  const webFiles = files.filter((f) => /(^|\/)(apps\/web|next\.config|middleware)/.test(f));
  check(webFiles.length === 0, "no web-app internals in the tarball", webFiles.length ? webFiles.join(", ") : "none");

  /* --- secret scan -------------------------------------------------------- */

  // Extract so file *contents* can be scanned. A filename check is not enough:
  // a leaked key inside a comment in dist/ would ship silently.
  const extractDir = join(tempRoot, "extract");
  mkdirSync(extractDir, { recursive: true });
  run("tar", ["-xzf", tarballPath, "-C", extractDir]);

  const extractedFiles = listFilesRecursive(join(extractDir, "package"))
    .filter((f) => /\.(js|d\.ts|json|md)$/.test(f));

  const secretPatterns = [
    { name: "Supabase service-role JWT", re: /service_role/ },
    { name: "JWT (three dot-separated base64url segments)", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
    { name: "hx_live_ API key literal", re: /hx_live_[A-Za-z0-9_-]{20,}/ },
    { name: "sk- style secret", re: /\bsk-[A-Za-z0-9]{20,}/ },
    { name: "AWS access key id", re: /AKIA[0-9A-Z]{16}/ },
    { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
    { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: "supabase project url", re: /https:\/\/[a-z0-9]{20}\.supabase\.co/ },
    { name: "SUPABASE_SERVICE_ROLE_KEY env name", re: /SUPABASE_SERVICE_ROLE_KEY/ },
  ];

  const secretHits = [];
  for (const file of extractedFiles) {
    const content = readFileSync(file, "utf8");
    for (const { name, re } of secretPatterns) {
      if (re.test(content)) {
        secretHits.push(`${relative(extractDir, file)}: ${name}`);
      }
    }
  }
  check(
    secretHits.length === 0,
    "no credentials or service-role references in shipped files",
    secretHits.length ? secretHits.join("; ") : `${extractedFiles.length} files scanned`,
  );

  /* --- published manifest inside the tarball ------------------------------ */

  const packedPkg = JSON.parse(
    readFileSync(join(extractDir, "package", "package.json"), "utf8"),
  );
  const packedWorkspaceRefs = Object.entries({
    ...(packedPkg.dependencies ?? {}),
    ...(packedPkg.devDependencies ?? {}),
  }).filter(([, v]) => String(v).includes("workspace:"));

  check(
    packedWorkspaceRefs.length === 0,
    "published manifest has no workspace: references",
    packedWorkspaceRefs.length
      ? packedWorkspaceRefs.map(([k, v]) => `${k}@${v}`).join(", ")
      : "none",
  );

  // npm rewrites `workspace:*` but leaves a bare `workspace:` in some protocol
  // forms. Check the raw text too, belt and braces.
  const packedManifestText = readFileSync(
    join(extractDir, "package", "package.json"),
    "utf8",
  );
  check(
    !packedManifestText.includes("workspace:"),
    "published manifest text contains no `workspace:` string",
  );

  check(
    packedPkg.name === pkg.name && packedPkg.version === pkg.version,
    "packed name/version match the source manifest",
    `${packedPkg.name}@${packedPkg.version}`,
  );

  // Integrity, so a rebuilt artifact can be compared later.
  const tarballBytes = readFileSync(tarballPath);
  const sha256 = createHash("sha256").update(tarballBytes).digest("hex");
  ok("tarball sha256", sha256);
  ok("tarball size", `${tarballBytes.length} bytes uncompressed`);

  /* --- external consumer install ------------------------------------------ */

  if (SKIP_INSTALL) {
    warn("external consumer install SKIPPED", "--skip-install was passed");
  } else {
    section("external consumer (outside the monorepo)");

    const consumerDir = join(tempRoot, "consumer");
    mkdirSync(consumerDir, { recursive: true });

    // Deliberately no monorepo, no workspace, no pnpm â€” a plain npm project,
    // which is the least forgiving consumer and the one most users will be.
    writeFileSync(
      join(consumerDir, "package.json"),
      JSON.stringify(
        {
          name: "release-check-consumer",
          private: true,
          type: "module",
          dependencies: { [pkg.name]: `file:${tarballPath}` },
        },
        null,
        2,
      ),
    );

    try {
      run(resolveBin("npm"), ["install", "--no-audit", "--no-fund"], { cwd: consumerDir });
      ok("npm install from the tarball succeeds");
    } catch (error) {
      fail("npm install from the tarball", String(error.stdout ?? error.message).slice(0, 400));
    }

    const installedDir = join(consumerDir, "node_modules", pkg.name);
    if (check(existsSync(installedDir), "package installed into node_modules")) {
      const installedPkg = JSON.parse(
        readFileSync(join(installedDir, "package.json"), "utf8"),
      );
      check(
        !JSON.stringify(installedPkg).includes("workspace:"),
        "installed manifest has no workspace: reference",
      );

      // A consumer must not receive transitive dependencies. If npm installed
      // anything else, a dependency crept in.
      const installedEntries = readdirSync(join(consumerDir, "node_modules")).filter(
        (n) => !n.startsWith("."),
      );
      check(
        installedEntries.length === 1,
        "exactly one package installed (no transitive dependencies)",
        installedEntries.join(", "),
      );
    }

    /* --- runtime import --------------------------------------------------- */

    const smokePath = join(consumerDir, "smoke.mjs");
    writeFileSync(
      smokePath,
      `
import { HextrailClient, HextrailError, LOCAL_ENDPOINT, getDurationMs } from "${pkg.name}";
import { SCHEMA_VERSION, TRACE_STATUSES } from "${pkg.name}/schema";

const fails = [];
const assert = (cond, msg) => { if (!cond) fails.push(msg); };

assert(typeof HextrailClient === "function", "HextrailClient is not a constructor");
assert(typeof HextrailError === "function", "HextrailError is not a constructor");
assert(typeof LOCAL_ENDPOINT === "string", "LOCAL_ENDPOINT is not a string");
assert(LOCAL_ENDPOINT.endsWith("/api/v1/traces"), "LOCAL_ENDPOINT does not target the ingest route");
assert(getDurationMs("2026-10-15T10:00:00.000Z", "2026-10-15T10:00:01.000Z") === 1000, "getDurationMs wrong");
assert(SCHEMA_VERSION === 1, "SCHEMA_VERSION wrong");
assert(Array.isArray(TRACE_STATUSES), "TRACE_STATUSES is not an array");

// Omitting the endpoint must be a clear, immediate configuration error - the
// behaviour that replaced defaulting to a host that does not resolve.
try {
  new HextrailClient({ apiKey: "hx_live_" + "A".repeat(43) });
  fails.push("omitting the endpoint should throw");
} catch (error) {
  assert(error instanceof TypeError, "missing endpoint should throw a TypeError");
  assert(/endpoint/.test(error.message), "missing endpoint error should name the option");
  assert(!error.message.includes("hx_live_"), "endpoint error must not echo the API key");
}

// Errors must cross the package boundary as real HextrailError instances.
const client = new HextrailClient({ apiKey: "hx_live_" + "A".repeat(43), endpoint: "http://127.0.0.1:9/x", maxRetries: 0 });
try {
  await client.ingestTrace({ schemaVersion: 1, trace: { traceId: "t", name: "n", startedAt: new Date().toISOString(), status: "ok" }, spans: [] });
  fails.push("a request to a dead port should not succeed");
} catch (error) {
  assert(error instanceof HextrailError, "thrown error is not a HextrailError");
  assert(error instanceof Error, "thrown error is not an Error");
  assert(typeof error.kind === "string", "error.kind missing");
}

if (fails.length) { console.error("SMOKE FAILURES: " + fails.join(" | ")); process.exit(1); }
console.log("runtime import OK");
`,
    );

    try {
      const output = run("node", ["smoke.mjs"], { cwd: consumerDir });
      ok("runtime import from a clean project", output.trim());
    } catch (error) {
      fail(
        "runtime import from a clean project",
        String(error.stdout ?? error.message).slice(0, 400),
      );
    }

    /* --- type-check with skipLibCheck: false ------------------------------ */

    writeFileSync(
      join(consumerDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            // The point of the exercise: do not paper over broken declarations.
            skipLibCheck: false,
            lib: ["ES2022", "DOM"],
          },
          include: ["types.ts"],
        },
        null,
        2,
      ),
    );

    writeFileSync(
      join(consumerDir, "types.ts"),
      `
import { HextrailClient, HextrailError, type TraceEnvelope, type IngestResponse } from "${pkg.name}";
import { SCHEMA_VERSION, type TraceStatus } from "${pkg.name}/schema";

// Realistic payload, including values that previously drifted from the server.
const envelope: TraceEnvelope = {
  schemaVersion: 1,
  trace: {
    traceId: "t1",
    name: "agent",
    startedAt: "2026-10-15T10:00:00.000Z",
    status: "running",
  },
  spans: [{ spanId: "s1", name: "llm.call", kind: "llm", startedAt: "2026-10-15T10:00:00.000Z", status: "ok" }],
};

const status: TraceStatus = "running";
const version: 1 = SCHEMA_VERSION;

// The endpoint option is required; a consumer must supply one. This line is
// the positive case - it must compile.
const client = new HextrailClient({
  apiKey: "hx_live_x",
  endpoint: "https://traces.example.com/api/v1/traces",
  maxRetries: 0,
});

// The negative case: omitting the endpoint must be a compile-time error, not a
// runtime surprise. Marked @ts-expect-error, so if the option ever became
// optional again this line stops erroring and tsc reports the now-unused
// suppression - which fails the check.
// @ts-expect-error - the endpoint option is required.
const missingEndpoint = new HextrailClient({ apiKey: "hx_live_x" });
void missingEndpoint;

async function send(): Promise<IngestResponse> {
  try {
    return await client.ingestTrace(envelope);
  } catch (error) {
    if (error instanceof HextrailError) {
      const kind: string = error.kind;
      const after: number | null = error.retryAfterMs;
      void kind; void after;
    }
    throw error;
  }
}

void status; void version; void send;
`,
    );

    // Resolve tsc from the repo, not from the consumer, so the check does not
    // depend on the consumer having a compiler of its own.
    const tscCandidates = [
      join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"),
      join(SDK_DIR, "node_modules", "typescript", "bin", "tsc"),
    ];
    const tscBin = tscCandidates.find((p) => existsSync(p));

    if (!tscBin) {
      warn("consumer type-check SKIPPED", "tsc not found in the workspace");
    } else {
      try {
        run("node", [tscBin, "-p", "tsconfig.json"], { cwd: consumerDir });
        ok("consumer type-check passes with skipLibCheck: false");
      } catch (error) {
        fail(
          "consumer type-check with skipLibCheck: false",
          String(error.stdout ?? error.message).slice(0, 600),
        );
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 8. endpoint configuration must stay explicit                                */
/* -------------------------------------------------------------------------- */

section("endpoint configuration (explicit, no unverified default)");

const clientSource = readFileSync(join(SDK_DIR, "src", "client.ts"), "utf8");

// Hextrail has no hosted ingestion endpoint. An earlier release defaulted to
// ingest.hextrail.ai, which does not resolve; the fix was to require the
// option. This section now guards against that regressing: the package must
// not ship a default that points somewhere unverified.

check(
  !/export\s+const\s+DEFAULT_ENDPOINT/.test(clientSource),
  "no DEFAULT_ENDPOINT export (an unverified default must not ship)",
);

check(
  /endpoint:\s*string;/.test(clientSource),
  "`endpoint` is a required option, not optional",
);

check(
  /function\s+resolveEndpoint\s*\(/.test(clientSource),
  "endpoint is validated before use",
);

// A missing endpoint must fail loudly and name the option, and must not echo
// any part of the key while doing so.
check(
  /endpoint` is required/.test(clientSource),
  "missing endpoint produces a message naming the option",
);

{
  const readme = readFileSync(join(SDK_DIR, "README.md"), "utf8");

  check(
    /Why `endpoint` is required/.test(readme),
    "README explains why there is no default endpoint",
  );

  check(
    /LOCAL_ENDPOINT/.test(readme),
    "README documents LOCAL_ENDPOINT for local development",
  );

  // The retired host must not reappear in the docs as something to use.
  check(
    !/endpoint.*ingest\.hextrail\.ai/i.test(readme),
    "README does not present the dead ingest.hextrail.ai host as usable",
  );
}

// The constant that replaces the old default must exist and point at the
// route the web app actually serves.
const localEndpointMatch = /export\s+const\s+LOCAL_ENDPOINT\s*=\s*"([^"]+)"/.exec(
  clientSource,
);

if (!localEndpointMatch) {
  warn("LOCAL_ENDPOINT not found in src/client.ts", "check manually");
} else {
  ok("LOCAL_ENDPOINT is declared", localEndpointMatch[1]);
  check(
    localEndpointMatch[1] === "http://localhost:3000/api/v1/traces",
    "LOCAL_ENDPOINT matches the web app's ingestion route",
  );
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */

console.log(`\n${DIM}${"=".repeat(66)}${RESET}`);
const total = results.length;
const passed = results.filter((r) => r.level === "ok").length;
console.log(
  `${passed}/${total} checks passed, ${failures} failed, ${warnings} warnings`,
);

if (tempRoot && !KEEP) {
  console.log(`${DIM}temp artifacts removed (pass --keep to inspect)${RESET}`);
} else if (tempRoot) {
  console.log(`${DIM}artifacts kept at ${tempRoot}${RESET}`);
}

if (failures > 0) {
  console.log(`\n${RED}NOT RELEASABLE${RESET} â€” fix the failures above.`);
  process.exit(1);
}

console.log(`\n${GREEN}RELEASE CHECKS PASSED${RESET}`);
console.log(
  `${YELLOW}Note${RESET}: this does not publish. See README "Publishing the SDK".`,
);

