import { describe, expect, it } from "vitest";

import { safeNext } from "@/lib/auth/next-path";

/**
 * Open-redirect tests for the `?next=` parameter.
 *
 * This is the one place the login page trusts client input to choose a
 * destination, so the negative cases matter more than the positive one.
 */

describe("safeNext", () => {
  it("allows a plain path", () => {
    expect(safeNext("/traces")).toBe("/traces");
  });

  it("allows a path with a query string", () => {
    expect(safeNext("/traces?status=error")).toBe("/traces?status=error");
  });

  it("allows the root", () => {
    expect(safeNext("/")).toBe("/");
  });

  it("takes the first value when the parameter repeats", () => {
    expect(safeNext(["/traces", "/settings"])).toBe("/traces");
  });

  it("falls back when the parameter is absent", () => {
    expect(safeNext(undefined)).toBe("/");
  });

  it("falls back for an empty string", () => {
    expect(safeNext("")).toBe("/");
  });

  it.each([
    "//evil.com",
    "//evil.com/traces",
    "/\\evil.com",
    "/\\/evil.com",
  ])("rejects the protocol-relative target %j", (value) => {
    expect(safeNext(value)).toBe("/");
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "/javascript:alert(1)",
    "/data:text/html,x",
  ])("rejects the scheme-bearing target %j", (value) => {
    expect(safeNext(value)).toBe("/");
  });

  it.each([
    "https://evil.com",
    "http://evil.com/traces",
    "HTTPS://EVIL.COM",
  ])("rejects the absolute URL %j", (value) => {
    expect(safeNext(value)).toBe("/");
  });

  it("rejects a relative path with no leading slash", () => {
    expect(safeNext("traces")).toBe("/");
  });

  it("does not let a scheme hide behind percent-encoding of the slash", () => {
    // `%2F%2Fevil.com` is not decoded here, so it fails the leading-slash
    // check and falls back — which is the safe outcome.
    expect(safeNext("%2F%2Fevil.com")).toBe("/");
  });
});
