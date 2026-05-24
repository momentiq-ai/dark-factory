// node:test → vitest assert-shim helpers.
//
// The sage3c source uses `node:test` + `node:assert` (`assert.equal`,
// `assert.throws`, `assert.match`, etc). The Phase B extraction converts
// the test runner to vitest while keeping test bodies legible. This shim
// translates the renamed `expect_*` helpers (produced by the conversion
// script) to vitest matchers.
//
// Keep the API surface identical to the node:assert calls being replaced;
// behavioral parity is what makes the conversion mechanical.

import { expect } from "vitest";

// Class constructor (e.g. `SchemaError`) — for `assert.throws(fn, ErrorClass)`
// pattern (instanceof check).
type ErrorClass = new (...args: never[]) => Error;
type ThrowsMatcher =
  | RegExp
  | Error
  | ErrorClass
  | ((e: unknown) => boolean);

function isErrorClass(m: unknown): m is ErrorClass {
  return typeof m === "function" && /^class\s/.test(Function.prototype.toString.call(m));
}

export function expect_eq<T>(actual: T, expected: T, _msg?: string): void {
  expect(actual).toBe(expected);
}

export function expect_ne<T>(actual: T, expected: T, _msg?: string): void {
  expect(actual).not.toBe(expected);
}

export function expect_deep<T>(actual: T, expected: T, _msg?: string): void {
  expect(actual).toEqual(expected);
}

export function expect_match(actual: string, re: RegExp, _msg?: string): void {
  expect(actual).toMatch(re);
}

export function expect_no_match(actual: string, re: RegExp, _msg?: string): void {
  expect(actual).not.toMatch(re);
}

export function expect_truthy(value: unknown, _msg?: string): void {
  expect(value).toBeTruthy();
}

export function expect_throws(
  fn: () => unknown,
  matcher?: ThrowsMatcher,
  _msg?: string,
): void {
  if (matcher === undefined) {
    expect(fn).toThrow();
    return;
  }
  if (matcher instanceof RegExp) {
    expect(fn).toThrow(matcher);
    return;
  }
  if (isErrorClass(matcher)) {
    expect(fn).toThrow(matcher);
    return;
  }
  if (matcher instanceof Error) {
    expect(fn).toThrow(matcher.message);
    return;
  }
  if (typeof matcher === "function") {
    try {
      fn();
      expect.fail("expected to throw");
    } catch (e) {
      expect(matcher(e)).toBeTruthy();
    }
    return;
  }
  expect(fn).toThrow();
}

export async function expect_rejects(
  p: Promise<unknown> | (() => Promise<unknown>),
  matcher?: ThrowsMatcher,
  _msg?: string,
): Promise<void> {
  const fn = typeof p === "function" ? p : () => p;
  if (matcher === undefined) {
    await expect(fn()).rejects.toThrow();
    return;
  }
  if (matcher instanceof RegExp) {
    await expect(fn()).rejects.toThrow(matcher);
    return;
  }
  if (isErrorClass(matcher)) {
    await expect(fn()).rejects.toThrow(matcher);
    return;
  }
  if (matcher instanceof Error) {
    await expect(fn()).rejects.toThrow(matcher.message);
    return;
  }
  if (typeof matcher === "function") {
    try {
      await fn();
      expect.fail("expected to reject");
    } catch (e) {
      const ok = await Promise.resolve((matcher as (e: unknown) => boolean | Promise<boolean>)(e));
      expect(ok).toBeTruthy();
    }
    return;
  }
  await expect(fn()).rejects.toThrow();
}
