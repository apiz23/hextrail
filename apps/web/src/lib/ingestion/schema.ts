import { z } from "zod";
import type { TraceEnvelope } from "@hextrail/sdk/schema";

/**
 * Ingestion payload validation.
 *
 * The wire contract is `TraceEnvelope` from the SDK. These Zod schemas mirror
 * that shape and validate it at the boundary, so nothing reaches the database
 * unchecked.
 */

/** ISO 8601 timestamp that must actually parse. */
const isoDateTime = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: "must be a valid ISO 8601 date-time string",
  });

/**
 * Matches the Postgres `uuid` type by shape.
 *
 * NOT `z.string().uuid()`. Zod additionally enforces an RFC 4122 version nibble
 * (`[1-8]`) and variant (`[89ab]`), so ids Postgres accepts — `1111...`,
 * `9999...`, an all-zero uuid — are rejected here first. That is not academic:
 * the ownership check exists to answer `403 projectId does not match your key`
 * for a *well-formed-but-foreign* id, and a stricter validator turned those
 * into `400 invalid_payload` before the check ever ran.
 *
 * The same pattern is used in the API key routes for the same reason.
 */
const uuidLike = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "must be a valid uuid",
  );

export const traceStatusSchema = z.enum(["ok", "error", "running"]);

export const spanKindSchema = z.enum([
  "agent",
  "llm",
  "tool",
  "retriever",
  "chain",
  "custom",
]);

export const spanErrorSchema = z.object({
  name: z.string().min(1).max(200),
  message: z.string().min(1).max(4000),
});

export const spanInputSchema = z
  .object({
    spanId: z.string().min(1).max(200),
    parentSpanId: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(200),
    kind: spanKindSchema,
    startedAt: isoDateTime,
    endedAt: isoDateTime.optional(),
    status: traceStatusSchema,
    attributes: z.record(z.string(), z.unknown()).optional(),
    error: spanErrorSchema.optional(),
  })
  .refine(
    (span) =>
      span.endedAt === undefined ||
      Date.parse(span.endedAt) >= Date.parse(span.startedAt),
    { message: "endedAt must not precede startedAt", path: ["endedAt"] },
  );

export const traceInputSchema = z
  .object({
    traceId: z.string().min(1).max(200),
    projectId: uuidLike.optional(),
    name: z.string().min(1).max(200),
    startedAt: isoDateTime,
    endedAt: isoDateTime.optional(),
    status: traceStatusSchema,
    environment: z.string().max(100).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (trace) =>
      trace.endedAt === undefined ||
      Date.parse(trace.endedAt) >= Date.parse(trace.startedAt),
    { message: "endedAt must not precede startedAt", path: ["endedAt"] },
  );

export const ingestPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  trace: traceInputSchema,
  spans: z.array(spanInputSchema).max(500, "a trace may contain at most 500 spans"),
});

export type IngestPayload = z.infer<typeof ingestPayloadSchema>;

/**
 * Compile-time assertion that the published SDK contract and this runtime
 * validator still describe the same payload.
 *
 * DIRECTION MATTERS. An earlier version asserted
 * `IngestPayload extends z.infer<z.ZodType<TraceEnvelope>>`, which made Zod
 * *infer* from `TraceEnvelope` rather than check against it — so it compared the
 * SDK type with itself and could never fail. That is how `TraceStatus` drifted
 * apart from the runtime enum without a single test complaining.
 *
 * This asserts structural equality both ways, in the direction that matters:
 *   - `Runtime extends Contract` — every payload the server accepts is also
 *     accepted by the SDK's types, so a caller cannot type what the server
 *     would reject.
 *   - `Contract extends Runtime` — anything the SDK permits is actually
 *     accepted, so the published types do not promise more than the server
 *     delivers.
 * A mismatch makes one of these `false`, which trips the `never` below and
 * fails the build at the exact line that drifted.
 */
type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;
type _RuntimeMatchesContract = Assert<Extends<IngestPayload, TraceEnvelope>>;
type _ContractMatchesRuntime = Assert<Extends<TraceEnvelope, IngestPayload>>;
// Referenced so the assertion types are not reported as unused, and so the
// dependency is visible to anyone editing these schemas.
export type ContractsAgree = [
  _RuntimeMatchesContract,
  _ContractMatchesRuntime,
];
