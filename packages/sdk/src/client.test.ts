import { afterEach, describe, expect, it, vi } from "vitest";

import { HextrailClient, LOCAL_ENDPOINT } from "./client.js";
import { HextrailError } from "./errors.js";
import type { TraceEnvelope } from "./index.js";

/**
 * Client tests.
 *
 * `fetch` is stubbed so each test declares the exact response, which lets the
 * suite cover outcomes that are hard to provoke against a live server:
 * mid-flight timeouts, socket errors, Retry-After on a 429, and a 2xx with an
 * unreadable body.
 *
 * No test waits real time. Retry delays are injected as a function returning 0.
 */

const API_KEY = `hx_live_${"A".repeat(43)}`;

const PAYLOAD: TraceEnvelope = {
  schemaVersion: 1,
  trace: {
    traceId: "trc_test_001",
    name: "support-agent",
    startedAt: "2026-10-15T10:00:00.000Z",
    endedAt: "2026-10-15T10:00:01.000Z",
    status: "ok",
    environment: "test",
  },
  spans: [
    {
      spanId: "spn_1",
      traceId: "trc_test_001",
      name: "llm.call",
      kind: "llm",
      startedAt: "2026-10-15T10:00:00.000Z",
      endedAt: "2026-10-15T10:00:01.000Z",
      status: "ok",
      attributes: { model: "gpt-5" },
    },
  ],
};

const SUCCESS_BODY = {
  traceId: "11111111-1111-1111-1111-111111111111",
  externalTraceId: "trc_test_001",
  spansAccepted: 1,
  duplicate: false,
};

interface StubCall {
  url: string;
  init: RequestInit;
}

interface StubResponseStep {
  kind: "response";
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  raw?: string;
}

interface StubRejectStep {
  kind: "reject";
  error: unknown;
}

/** A fetch stub that returns queued responses/errors in order. */
function stubFetch(plan: Array<StubResponseStep | StubRejectStep>) {
  const calls: StubCall[] = [];
  let index = 0;

  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const step = plan[Math.min(index, plan.length - 1)];
    index++;

    if (step.kind === "reject") throw step.error;

    const headers = new Headers(step.headers ?? {});
    return new Response(step.raw ?? JSON.stringify(step.body ?? {}), {
      status: step.status,
      headers,
    });
  });

  return { fn: fn as unknown as typeof fetch, calls };
}

type ClientOptions = ConstructorParameters<typeof HextrailClient>[0];

function makeClient(
  fetchImpl: typeof fetch,
  overrides: Partial<ClientOptions> = {},
) {
  return new HextrailClient({
    apiKey: API_KEY,
    endpoint: "http://localhost:3000/api/v1/traces",
    // Retries must be instant in tests.
    retryDelayMs: () => 0,
    fetch: fetchImpl,
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("construction", () => {
  it("rejects a missing or blank API key", () => {
    // `endpoint` is supplied in every case so the failure can only be the key.
    expect(
      () => new HextrailClient({ apiKey: "", endpoint: LOCAL_ENDPOINT }),
    ).toThrow(/apiKey.*required/i);
    expect(
      () => new HextrailClient({ apiKey: "   ", endpoint: LOCAL_ENDPOINT }),
    ).toThrow(/apiKey.*required/i);
    // @ts-expect-error - runtime guard for JavaScript callers.
    expect(() => new HextrailClient({ endpoint: LOCAL_ENDPOINT })).toThrow(
      /apiKey.*required/i,
    );
  });

  it("rejects a missing options object for a JavaScript caller", () => {
    // @ts-expect-error - runtime guard for JavaScript callers.
    expect(() => new HextrailClient()).toThrow(/options object is required/i);
    // @ts-expect-error - runtime guard for JavaScript callers.
    expect(() => new HextrailClient(null)).toThrow(
      /options object is required/i,
    );
  });

  it("rejects a key that is not a Hextrail key", () => {
    expect(
      () =>
        new HextrailClient({
          apiKey: "sk-proj-something-else",
          endpoint: LOCAL_ENDPOINT,
        }),
    ).toThrow(/hx_live_/);
  });

  it("never echoes the key in the error it throws", () => {
    const secret = "sk-leak-me-please-1234567890";
    try {
      new HextrailClient({ apiKey: secret, endpoint: LOCAL_ENDPOINT });
      throw new Error("expected the constructor to throw");
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(secret);
    }
  });

  it("requires an endpoint, since there is no hosted default", () => {
    // The package previously defaulted to https://ingest.hextrail.ai, a host
    // that has never resolved. Omitting `endpoint` must now fail immediately
    // and say which option is missing.
    expect(
      // @ts-expect-error - runtime guard for JavaScript callers.
      () => new HextrailClient({ apiKey: API_KEY }),
    ).toThrow(/endpoint.*required/i);
  });

  it("names `endpoint` in the error, not the key", () => {
    try {
      // @ts-expect-error - runtime guard for JavaScript callers.
      new HextrailClient({ apiKey: API_KEY });
      throw new Error("expected the constructor to throw");
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).toContain("endpoint");
      // A configuration error must not become a key-disclosure vector.
      expect(message).not.toContain(API_KEY);
    }
  });

  it("rejects a blank endpoint", () => {
    expect(
      () => new HextrailClient({ apiKey: API_KEY, endpoint: "" }),
    ).toThrow(/endpoint.*required/i);
    expect(
      () => new HextrailClient({ apiKey: API_KEY, endpoint: "   " }),
    ).toThrow(/endpoint.*required/i);
  });

  it("rejects a relative path", () => {
    expect(
      () =>
        new HextrailClient({
          apiKey: API_KEY,
          endpoint: "/api/v1/traces",
        }),
    ).toThrow(/not a valid absolute URL/);
  });

  it("rejects a URL with no scheme", () => {
    expect(
      () =>
        new HextrailClient({
          apiKey: API_KEY,
          endpoint: "ingest.example.com/api/v1/traces",
        }),
    ).toThrow(/not a valid absolute URL/);
  });

  it("rejects a non-http scheme", () => {
    expect(
      () =>
        new HextrailClient({
          apiKey: API_KEY,
          endpoint: "ftp://example.com/api/v1/traces",
        }),
    ).toThrow(/must use http or https/);
    expect(
      () =>
        new HextrailClient({
          apiKey: API_KEY,
          endpoint: "file:///tmp/traces",
        }),
    ).toThrow(/must use http or https/);
  });

  it("echoes a malformed endpoint so a typo is findable", () => {
    // An endpoint is not a secret — unlike the key, it belongs in the message.
    expect(
      () =>
        new HextrailClient({
          apiKey: API_KEY,
          endpoint: "not a url at all",
        }),
    ).toThrow(/not a url at all/);
  });

  it("accepts LOCAL_ENDPOINT unchanged", () => {
    const client = new HextrailClient({
      apiKey: API_KEY,
      endpoint: LOCAL_ENDPOINT,
      fetch: vi.fn() as never,
    });
    expect(client.endpoint).toBe("http://localhost:3000/api/v1/traces");
  });

  it("accepts an https endpoint", () => {
    const client = new HextrailClient({
      apiKey: API_KEY,
      endpoint: "https://traces.example.com/api/v1/traces",
      fetch: vi.fn() as never,
    });
    expect(client.endpoint).toBe(
      "https://traces.example.com/api/v1/traces",
    );
  });

  it("trims surrounding whitespace on an endpoint", () => {
    const client = new HextrailClient({
      apiKey: API_KEY,
      endpoint: "  https://traces.example.com/api/v1/traces  ",
      fetch: vi.fn() as never,
    });
    expect(client.endpoint).toBe(
      "https://traces.example.com/api/v1/traces",
    );
  });

  it("tolerates a trailing slash on a custom endpoint", () => {
    const client = new HextrailClient({
      apiKey: API_KEY,
      endpoint: "http://localhost:3000/api/v1/traces/",
      fetch: vi.fn() as never,
    });
    expect(client.endpoint).toBe("http://localhost:3000/api/v1/traces");
  });

  it("rejects nonsensical numeric options", () => {
    expect(
      () =>
        new HextrailClient({
          apiKey: API_KEY,
          endpoint: LOCAL_ENDPOINT,
          timeoutMs: 0,
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new HextrailClient({
          apiKey: API_KEY,
          endpoint: LOCAL_ENDPOINT,
          maxRetries: -1,
        }),
    ).toThrow(TypeError);
  });
});

describe("successful request", () => {
  it("POSTs the payload and returns the parsed response", async () => {
    const { fn, calls } = stubFetch([
      { kind: "response", status: 201, body: SUCCESS_BODY },
    ]);
    const client = makeClient(fn);

    const result = await client.ingestTrace(PAYLOAD);

    expect(result).toEqual(SUCCESS_BODY);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:3000/api/v1/traces");
    expect(calls[0].init.method).toBe("POST");
  });

  it("sends the key as a bearer token and nothing else secret", async () => {
    const { fn, calls } = stubFetch([
      { kind: "response", status: 201, body: SUCCESS_BODY },
    ]);
    await makeClient(fn).ingestTrace(PAYLOAD);

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");

    // The key must not also appear in the URL or the body.
    expect(calls[0].url).not.toContain(API_KEY);
    expect(String(calls[0].init.body)).not.toContain(API_KEY);
  });

  it("serialises the envelope unchanged", async () => {
    const { fn, calls } = stubFetch([
      { kind: "response", status: 201, body: SUCCESS_BODY },
    ]);
    await makeClient(fn).ingestTrace(PAYLOAD);
    expect(JSON.parse(String(calls[0].init.body))).toEqual(PAYLOAD);
  });

  it("treats a 200 duplicate as a success", async () => {
    const { fn } = stubFetch([
      {
        kind: "response",
        status: 200,
        body: { ...SUCCESS_BODY, duplicate: true },
      },
    ]);
    const result = await makeClient(fn).ingestTrace(PAYLOAD);
    expect(result.duplicate).toBe(true);
  });

  it("accepts 'running' as a status, matching the server", async () => {
    const { fn, calls } = stubFetch([
      { kind: "response", status: 201, body: SUCCESS_BODY },
    ]);
    await makeClient(fn).ingestTrace({
      ...PAYLOAD,
      trace: { ...PAYLOAD.trace, status: "running", endedAt: undefined },
    });
    // Compiles and is sent. The SDK type previously forbade this while the
    // server accepted it.
    expect(JSON.parse(String(calls[0].init.body)).trace.status).toBe("running");
  });

  it("allows projectId to be omitted", async () => {
    const { fn, calls } = stubFetch([
      { kind: "response", status: 201, body: SUCCESS_BODY },
    ]);
    await makeClient(fn).ingestTrace(PAYLOAD);
    expect("projectId" in JSON.parse(String(calls[0].init.body)).trace).toBe(
      false,
    );
  });
});

describe("authentication failures", () => {
  it("surfaces a 401 as a non-retryable auth error", async () => {
    const { fn, calls } = stubFetch([
      {
        kind: "response",
        status: 401,
        body: {
          error: {
            code: "unauthorized",
            message: "The API key is invalid or revoked.",
          },
        },
      },
    ]);

    await expect(makeClient(fn).ingestTrace(PAYLOAD)).rejects.toMatchObject({
      kind: "auth",
      status: 401,
      code: "unauthorized",
      retryable: false,
    });

    // A bad key will still be bad on the next attempt.
    expect(calls).toHaveLength(1);
  });

  it("surfaces a 403 as an auth error", async () => {
    const { fn } = stubFetch([
      {
        kind: "response",
        status: 403,
        body: { error: { code: "forbidden", message: "nope" } },
      },
    ]);
    await expect(makeClient(fn).ingestTrace(PAYLOAD)).rejects.toMatchObject({
      kind: "auth",
      status: 403,
    });
  });

  it("flags auth errors with isAuthError", async () => {
    const { fn } = stubFetch([
      {
        kind: "response",
        status: 401,
        body: { error: { code: "unauthorized" } },
      },
    ]);
    await expect(makeClient(fn).ingestTrace(PAYLOAD)).rejects.toSatisfy(
      (error: HextrailError) => error.isAuthError === true,
    );
  });
});

describe("invalid payloads", () => {
  it("surfaces 400 with the server's per-field details", async () => {
    const { fn, calls } = stubFetch([
      {
        kind: "response",
        status: 400,
        body: {
          error: {
            code: "invalid_payload",
            message: "The payload did not match the expected trace schema.",
            details: [{ path: "trace.name", message: "Too small" }],
          },
        },
      },
    ]);

    await expect(makeClient(fn).ingestTrace(PAYLOAD)).rejects.toMatchObject({
      kind: "invalid_payload",
      status: 400,
      retryable: false,
      details: [{ path: "trace.name", message: "Too small" }],
    });

    // Resending an identical bad payload cannot help.
    expect(calls).toHaveLength(1);
  });

  it("surfaces 413 as a non-retryable payload error", async () => {
    const { fn } = stubFetch([
      {
        kind: "response",
        status: 413,
        body: { error: { code: "payload_too_large" } },
      },
    ]);
    await expect(makeClient(fn).ingestTrace(PAYLOAD)).rejects.toMatchObject({
      kind: "invalid_payload",
      status: 413,
      retryable: false,
    });
  });

  it("rejects a wrong schemaVersion before sending", async () => {
    const { fn, calls } = stubFetch([
      { kind: "response", status: 201, body: SUCCESS_BODY },
    ]);
    await expect(
      makeClient(fn).ingestTrace({ ...PAYLOAD, schemaVersion: 2 as never }),
    ).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("reports an unserialisable payload as a client error", async () => {
    const { fn, calls } = stubFetch([
      { kind: "response", status: 201, body: SUCCESS_BODY },
    ]);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      makeClient(fn).ingestTrace({
        ...PAYLOAD,
        trace: { ...PAYLOAD.trace, metadata: circular },
      }),
    ).rejects.toMatchObject({ kind: "invalid_payload", retryable: false });

    expect(calls).toHaveLength(0);
  });
});

describe("network failures", () => {
  it("retries a socket error and succeeds", async () => {
    const socketError = Object.assign(new Error("ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const { fn, calls } = stubFetch([
      { kind: "reject", error: socketError },
      { kind: "response", status: 201, body: SUCCESS_BODY },
    ]);

    const result = await makeClient(fn).ingestTrace(PAYLOAD);
    expect(result).toEqual(SUCCESS_BODY);
    expect(calls).toHaveLength(2);
  });

  it("gives up after maxRetries and reports a network error", async () => {
    const { fn, calls } = stubFetch([
      { kind: "reject", error: new Error("fetch failed") },
    ]);

    await expect(
      makeClient(fn, { maxRetries: 2 }).ingestTrace(PAYLOAD),
    ).rejects.toMatchObject({ kind: "network", retryable: true });

    // 1 initial attempt plus 2 retries.
    expect(calls).toHaveLength(3);
  });

  it("does not retry when maxRetries is 0", async () => {
    const { fn, calls } = stubFetch([
      { kind: "reject", error: new Error("fetch failed") },
    ]);

    await expect(
      makeClient(fn, { maxRetries: 0 }).ingestTrace(PAYLOAD),
    ).rejects.toMatchObject({ kind: "network" });
    expect(calls).toHaveLength(1);
  });

  it("does not leak the API key through a network error", async () => {
    const { fn } = stubFetch([
      { kind: "reject", error: new Error(`bad url with ${API_KEY} inside`) },
    ]);

    try {
      await makeClient(fn).ingestTrace(PAYLOAD);
      throw new Error("expected a rejection");
    } catch (error) {
      const serialised = `${(error as Error).message} ${JSON.stringify(error)}`;
      expect(serialised).not.toContain(API_KEY);
    }
  });
});

describe("timeout", () => {
  it("aborts and reports a timeout", async () => {
    // A fetch that never settles until the signal aborts.
    const hangingFetch = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    ) as unknown as typeof fetch;

    const client = new HextrailClient({
      apiKey: API_KEY,
      endpoint: "http://localhost:3000/api/v1/traces",
      timeoutMs: 20,
      maxRetries: 0,
      retryDelayMs: () => 0,
      fetch: hangingFetch,
    });

    await expect(client.ingestTrace(PAYLOAD)).rejects.toMatchObject({
      kind: "timeout",
      retryable: true,
    });
  });

  it("retries a timeout, since a retry cannot duplicate the trace", async () => {
    let attempt = 0;
    const flakyFetch = vi.fn(
      async (_url: string | URL, init?: RequestInit) => {
        attempt++;
        if (attempt === 1) {
          await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          });
        }
        return new Response(JSON.stringify(SUCCESS_BODY), { status: 201 });
      },
    ) as unknown as typeof fetch;

    const client = new HextrailClient({
      apiKey: API_KEY,
      endpoint: "http://localhost:3000/api/v1/traces",
      timeoutMs: 20,
      maxRetries: 2,
      retryDelayMs: () => 0,
      fetch: flakyFetch,
    });

    await expect(client.ingestTrace(PAYLOAD)).resolves.toEqual(SUCCESS_BODY);
    expect(attempt).toBe(2);
  });
});

describe("rate limits", () => {
  it("honours Retry-After and then succeeds", async () => {
    const delays: Array<{ attempt: number; retryAfter: number | null }> = [];
    const { fn, calls } = stubFetch([
      {
        kind: "response",
        status: 429,
        headers: { "Retry-After": "3" },
        body: {
          error: { code: "rate_limited", message: "Too many requests." },
        },
      },
      { kind: "response", status: 201, body: SUCCESS_BODY },
    ]);

    const client = new HextrailClient({
      apiKey: API_KEY,
      endpoint: "http://localhost:3000/api/v1/traces",
      fetch: fn,
      // Record what the client decided, without actually waiting.
      retryDelayMs: (attempt, retryAfter) => {
        delays.push({ attempt, retryAfter });
        return 0;
      },
    });

    await expect(client.ingestTrace(PAYLOAD)).resolves.toEqual(SUCCESS_BODY);
    expect(calls).toHaveLength(2);
    // "3" seconds must become 3000ms, not 3ms.
    expect(delays[0]).toEqual({ attempt: 0, retryAfter: 3000 });
  });

  it("reports a rate limit with retryAfterMs when retries are exhausted", async () => {
    const { fn } = stubFetch([
      {
        kind: "response",
        status: 429,
        headers: { "Retry-After": "7" },
        body: {
          error: { code: "rate_limited", message: "Too many requests." },
        },
      },
    ]);

    await expect(
      makeClient(fn, { maxRetries: 0 }).ingestTrace(PAYLOAD),
    ).rejects.toMatchObject({
      kind: "rate_limit",
      status: 429,
      retryable: true,
      retryAfterMs: 7000,
    });
  });

  it("parses Retry-After given as an HTTP-date", async () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const { fn } = stubFetch([
      {
        kind: "response",
        status: 429,
        headers: { "Retry-After": future },
        body: { error: { code: "rate_limited" } },
      },
    ]);

    const error = await makeClient(fn, { maxRetries: 0 })
      .ingestTrace(PAYLOAD)
      .catch((caught: HextrailError) => caught);

    expect(error.kind).toBe("rate_limit");
    // Allow slack for execution time.
    expect(error.retryAfterMs).toBeGreaterThan(3000);
    expect(error.retryAfterMs).toBeLessThanOrEqual(5000);
  });

  it("falls back to backoff when Retry-After is missing or junk", async () => {
    for (const header of [undefined, "not-a-date"]) {
      const { fn } = stubFetch([
        {
          kind: "response",
          status: 429,
          ...(header ? { headers: { "Retry-After": header } } : {}),
          body: { error: { code: "rate_limited" } },
        },
      ]);
      const error = await makeClient(fn, { maxRetries: 0 })
        .ingestTrace(PAYLOAD)
        .catch((caught: HextrailError) => caught);
      expect(error.retryAfterMs).toBeNull();
    }
  });
});

describe("server failures and retries", () => {
  it("retries a 500 then succeeds", async () => {
    const { fn, calls } = stubFetch([
      {
        kind: "response",
        status: 500,
        body: { error: { code: "internal_error" } },
      },
      { kind: "response", status: 201, body: SUCCESS_BODY },
    ]);

    await expect(makeClient(fn).ingestTrace(PAYLOAD)).resolves.toEqual(
      SUCCESS_BODY,
    );
    expect(calls).toHaveLength(2);
  });

  it("retries 503 (limiter unavailable) - transient by design", async () => {
    const { fn, calls } = stubFetch([
      {
        kind: "response",
        status: 503,
        body: { error: { code: "rate_limiter_unavailable" } },
      },
      { kind: "response", status: 201, body: SUCCESS_BODY },
    ]);
    await expect(makeClient(fn).ingestTrace(PAYLOAD)).resolves.toEqual(
      SUCCESS_BODY,
    );
    expect(calls).toHaveLength(2);
  });

  it("stops after maxRetries on a persistent 500", async () => {
    const { fn, calls } = stubFetch([
      {
        kind: "response",
        status: 500,
        body: { error: { code: "internal_error" } },
      },
    ]);
    await expect(
      makeClient(fn, { maxRetries: 1 }).ingestTrace(PAYLOAD),
    ).rejects.toMatchObject({
      kind: "server",
      status: 500,
      retryable: true,
    });
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 400", async () => {
    const { fn, calls } = stubFetch([
      {
        kind: "response",
        status: 400,
        body: { error: { code: "invalid_json" } },
      },
    ]);
    await expect(makeClient(fn).ingestTrace(PAYLOAD)).rejects.toMatchObject({
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("does not retry a 401", async () => {
    const { fn, calls } = stubFetch([
      {
        kind: "response",
        status: 401,
        body: { error: { code: "unauthorized" } },
      },
    ]);
    await expect(makeClient(fn).ingestTrace(PAYLOAD)).rejects.toMatchObject({
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("handles a non-JSON error body without leaking it", async () => {
    const { fn } = stubFetch([
      {
        kind: "response",
        status: 502,
        raw: "<html><body>502 Bad Gateway</body></html>",
      },
    ]);

    const error = await makeClient(fn, { maxRetries: 0 })
      .ingestTrace(PAYLOAD)
      .catch((caught: HextrailError) => caught);

    expect(error.status).toBe(502);
    expect(error.message).toContain("502");
    // The raw HTML must not be echoed into the message.
    expect(error.message).not.toContain("<html>");
  });

  it("treats a 2xx with an unreadable body as a non-retryable failure", async () => {
    const { fn, calls } = stubFetch([
      { kind: "response", status: 201, raw: "not json at all" },
    ]);

    await expect(makeClient(fn).ingestTrace(PAYLOAD)).rejects.toMatchObject({
      kind: "invalid_response",
      retryable: false,
    });
    // Retrying could double-ingest, so it must not be attempted.
    expect(calls).toHaveLength(1);
  });
});

describe("idempotency semantics", () => {
  it("treats a retried duplicate as success, not an error", async () => {
    // The realistic sequence: the first request actually succeeded server-side
    // but the response was lost, so the retry comes back as a duplicate.
    const { fn, calls } = stubFetch([
      { kind: "reject", error: new Error("fetch failed") },
      {
        kind: "response",
        status: 200,
        body: { ...SUCCESS_BODY, duplicate: true },
      },
    ]);

    const result = await makeClient(fn).ingestTrace(PAYLOAD);

    expect(result.duplicate).toBe(true);
    expect(result.traceId).toBe(SUCCESS_BODY.traceId);
    expect(calls).toHaveLength(2);
    // Both attempts carried the same body, so the server sees the same traceId.
    expect(calls[0].init.body).toBe(calls[1].init.body);
  });

  it("sends the identical body on every attempt", async () => {
    const { fn, calls } = stubFetch([
      {
        kind: "response",
        status: 500,
        body: { error: { code: "internal_error" } },
      },
      {
        kind: "response",
        status: 500,
        body: { error: { code: "internal_error" } },
      },
      { kind: "response", status: 201, body: SUCCESS_BODY },
    ]);

    await makeClient(fn).ingestTrace(PAYLOAD);

    expect(calls).toHaveLength(3);
    const bodies = new Set(calls.map((call) => String(call.init.body)));
    expect(bodies.size).toBe(1);
  });
});
