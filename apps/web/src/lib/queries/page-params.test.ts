import { describe, expect, it } from "vitest";

import {
  firstValue,
  parseProjectId,
  parseQuery,
  parseRange,
  parseStatus,
  rangeSince,
} from "./page-params";

describe("firstValue", () => {
  it("passes a string through", () => {
    expect(firstValue("a")).toBe("a");
  });

  it("takes the first of an array", () => {
    expect(firstValue(["a", "b"])).toBe("a");
  });

  it("returns undefined when absent", () => {
    expect(firstValue(undefined)).toBeUndefined();
  });
});

describe("parseRange", () => {
  it.each(["1h", "24h", "7d", "30d"])("accepts %s", (value) => {
    expect(parseRange(value)).toBe(value);
  });

  it("defaults to 24h for anything else", () => {
    expect(parseRange("99y")).toBe("24h");
    expect(parseRange(undefined)).toBe("24h");
    expect(parseRange(["nonsense"])).toBe("24h");
  });
});

describe("rangeSince", () => {
  const now = Date.parse("2026-10-15T12:00:00.000Z");

  it("subtracts the range length", () => {
    expect(rangeSince("1h", now)).toBe("2026-10-15T11:00:00.000Z");
    expect(rangeSince("24h", now)).toBe("2026-10-14T12:00:00.000Z");
    expect(rangeSince("7d", now)).toBe("2026-10-08T12:00:00.000Z");
  });
});

describe("parseStatus", () => {
  it.each(["ok", "error", "running"])("accepts %s", (value) => {
    expect(parseStatus(value)).toBe(value);
  });

  it("returns undefined for anything else", () => {
    expect(parseStatus("all")).toBeUndefined();
    expect(parseStatus(undefined)).toBeUndefined();
  });
});

describe("parseQuery", () => {
  it("trims a value", () => {
    expect(parseQuery("  support  ")).toBe("support");
  });

  it("returns undefined for whitespace only", () => {
    expect(parseQuery("   ")).toBeUndefined();
    expect(parseQuery(undefined)).toBeUndefined();
  });

  it("caps the length", () => {
    expect(parseQuery("a".repeat(500))?.length).toBe(100);
  });
});

describe("parseProjectId", () => {
  const uuid = "b04f2dda-8e2c-49e2-b2d7-81d7696f674d";

  it("accepts a uuid", () => {
    expect(parseProjectId(uuid)).toBe(uuid);
  });

  it("accepts an uppercase uuid", () => {
    expect(parseProjectId(uuid.toUpperCase())).toBe(uuid.toUpperCase());
  });

  it("rejects a non-uuid so it never reaches a query", () => {
    expect(parseProjectId("prj_research")).toBeNull();
    expect(parseProjectId("1; drop table hx_traces")).toBeNull();
    expect(parseProjectId("")).toBeNull();
    expect(parseProjectId(undefined)).toBeNull();
  });

  it("rejects a uuid with trailing characters", () => {
    expect(parseProjectId(`${uuid}x`)).toBeNull();
  });
});
