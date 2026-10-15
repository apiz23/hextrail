import { describe, expect, it } from "vitest";
import { getDurationMs } from "./index.js";

describe("getDurationMs", () => {
  it("computes the difference between two valid ISO timestamps", () => {
    expect(
      getDurationMs("2026-10-12T10:00:00.000Z", "2026-10-12T10:00:01.500Z"),
    ).toBe(1500);
  });

  it("returns 0 for identical timestamps", () => {
    expect(
      getDurationMs("2026-10-12T10:00:00.000Z", "2026-10-12T10:00:00.000Z"),
    ).toBe(0);
  });

  it("throws when the start timestamp is not a valid date", () => {
    expect(() => getDurationMs("not-a-date", "2026-10-12T10:00:00.000Z")).toThrow(
      "Trace timestamps must be valid ISO date strings",
    );
  });

  it("throws when the end timestamp is not a valid date", () => {
    expect(() => getDurationMs("2026-10-12T10:00:00.000Z", "not-a-date")).toThrow(
      "Trace timestamps must be valid ISO date strings",
    );
  });

  it("throws when the end timestamp precedes the start timestamp", () => {
    expect(() =>
      getDurationMs("2026-10-12T10:00:01.000Z", "2026-10-12T10:00:00.000Z"),
    ).toThrow("Trace end must not precede its start");
  });
});
