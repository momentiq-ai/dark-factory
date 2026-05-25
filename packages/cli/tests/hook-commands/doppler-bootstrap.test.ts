// Cycle 331.1 Phase F-LOCAL — doppler-bootstrap unit tests.
//
// The OSS bootstrap loader is a slimmed port of sage3c's #1312 design.
// Critical invariants to verify:
//
//   1. Default allowlist = ["DOPPLER_TOKEN"] (no sage-specific keys).
//   2. Consumer-supplied allowlist works (the path Sage3C uses for
//      DOPPLER_SERVICE_TOKEN_SAGE).
//   3. Strict KEY=value parsing — bad keys / values are dropped.
//   4. Forbidden value chars (command-substitution attempt) are dropped.
//   5. The loader does NOT overwrite already-set env vars.
//   6. `serviceTokenAlias` bridges a project-scoped key to DOPPLER_TOKEN
//      (the sage3c bridge, parameterized).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_BOOTSTRAP_ALLOWLIST,
  loadDopplerBootstrapEnv,
} from "../../src/doppler-bootstrap.js";

describe("loadDopplerBootstrapEnv — default allowlist", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "df-bootstrap-test-"));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("default allowlist is exactly ['DOPPLER_TOKEN']", () => {
    expect([...DEFAULT_BOOTSTRAP_ALLOWLIST]).toEqual(["DOPPLER_TOKEN"]);
  });

  it("returns no-bootstrap-file when .env is absent", () => {
    const env: NodeJS.ProcessEnv = {};
    const result = loadDopplerBootstrapEnv({
      mainCheckoutRoot: tmpRoot,
      env,
    });
    expect(result.status).toBe("no-bootstrap-file");
    expect(result.loadedKeys).toEqual([]);
  });

  it("loads DOPPLER_TOKEN from .env when allowlisted (default)", () => {
    writeFileSync(join(tmpRoot, ".env"), "DOPPLER_TOKEN=dp.st.dev.abc123\n");
    const env: NodeJS.ProcessEnv = {};
    const result = loadDopplerBootstrapEnv({
      mainCheckoutRoot: tmpRoot,
      env,
    });
    expect(result.status).toBe("ok");
    expect(result.loadedKeys).toEqual(["DOPPLER_TOKEN"]);
    expect(env["DOPPLER_TOKEN"]).toBe("dp.st.dev.abc123");
  });

  it("drops keys NOT in the allowlist (no DOPPLER_SERVICE_TOKEN_SAGE by default)", () => {
    writeFileSync(
      join(tmpRoot, ".env"),
      "DOPPLER_SERVICE_TOKEN_SAGE=dp.st.sage.xyz\n",
    );
    const env: NodeJS.ProcessEnv = {};
    const result = loadDopplerBootstrapEnv({
      mainCheckoutRoot: tmpRoot,
      env,
    });
    // sage-specific key is NOT in the OSS default allowlist.
    expect(result.status).toBe("no-allowlisted-keys");
    expect(env["DOPPLER_SERVICE_TOKEN_SAGE"]).toBeUndefined();
  });

  it("does NOT overwrite already-set env vars", () => {
    writeFileSync(join(tmpRoot, ".env"), "DOPPLER_TOKEN=from-env-file\n");
    const env: NodeJS.ProcessEnv = { DOPPLER_TOKEN: "already-set-in-shell" };
    const result = loadDopplerBootstrapEnv({
      mainCheckoutRoot: tmpRoot,
      env,
    });
    expect(result.status).toBe("ok");
    expect(env["DOPPLER_TOKEN"]).toBe("already-set-in-shell");
    expect(result.loadedKeys).toEqual([]);
  });

  it("drops values containing command-substitution chars", () => {
    writeFileSync(
      join(tmpRoot, ".env"),
      "DOPPLER_TOKEN=dp.st.dev.$(curl evil)\n",
    );
    const env: NodeJS.ProcessEnv = {};
    const result = loadDopplerBootstrapEnv({
      mainCheckoutRoot: tmpRoot,
      env,
    });
    // Line was dropped before allowlist check; result is no-allowlisted-keys
    expect(env["DOPPLER_TOKEN"]).toBeUndefined();
    expect(result.status).toBe("no-allowlisted-keys");
  });

  it("strips matched quotes from values", () => {
    writeFileSync(join(tmpRoot, ".env"), 'DOPPLER_TOKEN="dp.st.dev.abc"\n');
    const env: NodeJS.ProcessEnv = {};
    const result = loadDopplerBootstrapEnv({
      mainCheckoutRoot: tmpRoot,
      env,
    });
    expect(env["DOPPLER_TOKEN"]).toBe("dp.st.dev.abc");
    expect(result.status).toBe("ok");
  });

  it("ignores comments and blank lines", () => {
    writeFileSync(
      join(tmpRoot, ".env"),
      "# comment\n\n   \nDOPPLER_TOKEN=valid\n",
    );
    const env: NodeJS.ProcessEnv = {};
    const result = loadDopplerBootstrapEnv({
      mainCheckoutRoot: tmpRoot,
      env,
    });
    expect(env["DOPPLER_TOKEN"]).toBe("valid");
    expect(result.status).toBe("ok");
  });
});

describe("loadDopplerBootstrapEnv — consumer allowlist override", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "df-bootstrap-test-"));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("accepts a custom allowlist (sage3c-style project-scoped key)", () => {
    writeFileSync(
      join(tmpRoot, ".env"),
      "DOPPLER_SERVICE_TOKEN_ACME=dp.st.acme.abc\n",
    );
    const env: NodeJS.ProcessEnv = {};
    const result = loadDopplerBootstrapEnv({
      mainCheckoutRoot: tmpRoot,
      env,
      allowlist: ["DOPPLER_TOKEN", "DOPPLER_SERVICE_TOKEN_ACME"],
    });
    expect(result.status).toBe("ok");
    expect(env["DOPPLER_SERVICE_TOKEN_ACME"]).toBe("dp.st.acme.abc");
  });

  it("serviceTokenAlias bridges to DOPPLER_TOKEN when latter is unset", () => {
    writeFileSync(
      join(tmpRoot, ".env"),
      "DOPPLER_SERVICE_TOKEN_ACME=dp.st.acme.abc\n",
    );
    const env: NodeJS.ProcessEnv = {};
    const result = loadDopplerBootstrapEnv({
      mainCheckoutRoot: tmpRoot,
      env,
      allowlist: ["DOPPLER_TOKEN", "DOPPLER_SERVICE_TOKEN_ACME"],
      serviceTokenAlias: "DOPPLER_SERVICE_TOKEN_ACME",
    });
    expect(result.status).toBe("ok");
    expect(result.mappedToDopplerToken).toBe(true);
    expect(env["DOPPLER_TOKEN"]).toBe("dp.st.acme.abc");
  });

  it("serviceTokenAlias does NOT overwrite an already-set DOPPLER_TOKEN", () => {
    writeFileSync(
      join(tmpRoot, ".env"),
      "DOPPLER_SERVICE_TOKEN_ACME=dp.st.acme.abc\nDOPPLER_TOKEN=already-set\n",
    );
    const env: NodeJS.ProcessEnv = {};
    const result = loadDopplerBootstrapEnv({
      mainCheckoutRoot: tmpRoot,
      env,
      allowlist: ["DOPPLER_TOKEN", "DOPPLER_SERVICE_TOKEN_ACME"],
      serviceTokenAlias: "DOPPLER_SERVICE_TOKEN_ACME",
    });
    expect(result.status).toBe("ok");
    expect(env["DOPPLER_TOKEN"]).toBe("already-set");
    expect(result.mappedToDopplerToken).toBe(false);
  });

  it("serviceTokenAlias NOT in allowlist is a no-op (the alias must also be readable)", () => {
    writeFileSync(
      join(tmpRoot, ".env"),
      "DOPPLER_SERVICE_TOKEN_ACME=dp.st.acme.abc\n",
    );
    const env: NodeJS.ProcessEnv = {};
    const result = loadDopplerBootstrapEnv({
      mainCheckoutRoot: tmpRoot,
      env,
      // Note: serviceTokenAlias is set but the key isn't in allowlist
      allowlist: ["DOPPLER_TOKEN"],
      serviceTokenAlias: "DOPPLER_SERVICE_TOKEN_ACME",
    });
    // The alias key was never read (not allowlisted), so the bridge can't fire.
    expect(env["DOPPLER_TOKEN"]).toBeUndefined();
    expect(result.mappedToDopplerToken).toBe(false);
  });
});
