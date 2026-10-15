import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  clampPageSize,
  decodeCursor,
  encodeCursor,
} from "./traces";

describe("clampPageSize", () => {
  it("defaults when unspecified", () => {
    expect(clampPageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
  });

  it("accepts a value in range", () => {
    expect(clampPageSize(10)).toBe(10);
  });

  it("caps at the maximum", () => {
    expect(clampPageSize(10_000)).toBe(MAX_PAGE_SIZE);
  });

  it("floors at one", () => {
    expect(clampPageSize(0)).toBe(1);
    expect(clampPageSize(-5)).toBe(1);
  });

  it("floors a fractional value", () => {
    expect(clampPageSize(7.9)).toBe(7);
  });

  it("ignores a non-numeric value", () => {
    expect(clampPageSize(Number.NaN)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PAGE_SIZE);
  });
});

describe("cursor round-trip", () => {
  it("survives encode then decode", () => {
    const cursor = {
      startedAt: "2026-10-15T10:00:00.000Z",
      id: "11111111-1111-1111-1111-111111111111",
    };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("is opaque — the raw timestamp is not in the token", () => {
    const encoded = encodeCursor({
      startedAt: "2026-10-15T10:00:00.000Z",
      id: "abc",
    });
    expect(encoded).not.toContain("2026");
    expect(encoded).not.toContain(":");
  });

  it("keeps an id containing a pipe intact", () => {
    // The separator is found with lastIndexOf, so a pipe inside the id does
    // not corrupt the split.
    const cursor = { startedAt: "2026-10-15T10:00:00.000Z", id: "a|b" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });
});

describe("decodeCursor rejects bad input", () => {
  it("returns null for an absent cursor", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });

  it("returns null for non-base64 garbage", () => {
    expect(decodeCursor("!!!not base64!!!")).toBeNull();
  });

  it("returns null when the payload is not a two-element tuple", () => {
    expect(
      decodeCursor(Buffer.from("no-separator-here", "utf8").toString("base64url")),
    ).toBeNull();
    expect(
      decodeCursor(Buffer.from("[1,2,3]", "utf8").toString("base64url")),
    ).toBeNull();
    expect(
      decodeCursor(Buffer.from("{}", "utf8").toString("base64url")),
    ).toBeNull();
  });

  it("returns null when the timestamp is unparseable", () => {
    const encoded = Buffer.from(
      JSON.stringify(["not-a-date", "some-id"]),
      "utf8",
    ).toString("base64url");
    expect(decodeCursor(encoded)).toBeNull();
  });

  it("returns null when the id is empty", () => {
    const encoded = Buffer.from(
      JSON.stringify(["2026-10-15T10:00:00.000Z", ""]),
      "utf8",
    ).toString("base64url");
    expect(decodeCursor(encoded)).toBeNull();
  });

  it("returns null when the tuple holds non-strings", () => {
    const encoded = Buffer.from(
      JSON.stringify([1, 2]),
      "utf8",
    ).toString("base64url");
    expect(decodeCursor(encoded)).toBeNull();
  });
});
