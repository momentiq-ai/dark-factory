import { describe, expect, it, vi } from "vitest";

import type { PublishedEvidence } from "@momentiq/dark-factory-schemas";

import {
  computeSignature,
  resolveTransmitConfig,
  resolveTransmitRepository,
  transmitEvidence,
  TransmitAuthError,
  TransmitError,
  SIGNATURE_HEADER,
} from "../../src/evidence/transmit.js";

const EVIDENCE: PublishedEvidence = {
  schemaVersion: 1,
  commit: "a".repeat(40),
  provenance: "consumer-attested",
  status: "complete",
  routes: {},
  diffHash: "sha256:deadbeef",
} as unknown as PublishedEvidence;

const CONFIG = { url: "https://ingest.example/events/evidence/publish", secret: "secret" };

function okResponse(status = 204): Response {
  return new Response(null, { status });
}

describe("resolveTransmitConfig", () => {
  it("returns null when DF_EVIDENCE_INGEST_URL is unset", () => {
    expect(resolveTransmitConfig({ DF_EVIDENCE_INGEST_SECRET: "s" })).toBeNull();
  });

  it("returns null when DF_EVIDENCE_INGEST_SECRET is unset", () => {
    expect(resolveTransmitConfig({ DF_EVIDENCE_INGEST_URL: "https://x" })).toBeNull();
  });

  it("returns null when either value is blank/whitespace", () => {
    expect(
      resolveTransmitConfig({ DF_EVIDENCE_INGEST_URL: "  ", DF_EVIDENCE_INGEST_SECRET: "s" }),
    ).toBeNull();
    expect(
      resolveTransmitConfig({ DF_EVIDENCE_INGEST_URL: "https://x", DF_EVIDENCE_INGEST_SECRET: " " }),
    ).toBeNull();
  });

  it("resolves and trims both values when present", () => {
    expect(
      resolveTransmitConfig({
        DF_EVIDENCE_INGEST_URL: "  https://x/evidence  ",
        DF_EVIDENCE_INGEST_SECRET: "  s  ",
      }),
    ).toEqual({ url: "https://x/evidence", secret: "s" });
  });
});

describe("resolveTransmitRepository", () => {
  it("prefers the explicit override", () => {
    expect(resolveTransmitRepository({ GITHUB_REPOSITORY: "env/repo" }, "flag/repo")).toBe(
      "flag/repo",
    );
  });

  it("falls back to GITHUB_REPOSITORY", () => {
    expect(resolveTransmitRepository({ GITHUB_REPOSITORY: "env/repo" })).toBe("env/repo");
  });

  it("returns null when neither is set (or blank)", () => {
    expect(resolveTransmitRepository({})).toBeNull();
    expect(resolveTransmitRepository({ GITHUB_REPOSITORY: "  " }, "  ")).toBeNull();
  });
});

describe("computeSignature", () => {
  it("computes the canonical sha256=<hex> HMAC (GitHub convention)", () => {
    // Known vector: HMAC-SHA256(key="secret", msg="hello").
    expect(computeSignature("secret", "hello")).toBe(
      "sha256=88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b",
    );
  });
});

describe("transmitEvidence", () => {
  it("POSTs the {repository, evidence} envelope signed over the EXACT raw body", async () => {
    let seenUrl = "";
    let seenBody = "";
    let seenSig = "";
    let seenContentType = "";
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenBody = String(init?.body);
      const headers = init?.headers as Record<string, string>;
      seenSig = headers[SIGNATURE_HEADER] ?? "";
      seenContentType = headers["content-type"] ?? "";
      return okResponse(204);
    });

    const result = await transmitEvidence({
      config: CONFIG,
      repository: "owner/repo",
      evidence: EVIDENCE,
      options: { fetch },
    });

    expect(result.status).toBe(204);
    expect(seenUrl).toBe(CONFIG.url);
    expect(seenContentType).toBe("application/json");
    // The body is the serialized envelope...
    expect(JSON.parse(seenBody)).toEqual({ repository: "owner/repo", evidence: EVIDENCE });
    // ...and the signature is computed over those EXACT bytes (not a re-serialization).
    expect(seenSig).toBe(computeSignature(CONFIG.secret, seenBody));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("throws TransmitAuthError on 401 (never retries)", async () => {
    const fetch = vi.fn(async () => okResponse(401));
    await expect(
      transmitEvidence({ config: CONFIG, repository: "o/r", evidence: EVIDENCE, options: { fetch } }),
    ).rejects.toBeInstanceOf(TransmitAuthError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("throws TransmitError on a non-auth 4xx (never retries)", async () => {
    const fetch = vi.fn(async () => okResponse(400));
    await expect(
      transmitEvidence({ config: CONFIG, repository: "o/r", evidence: EVIDENCE, options: { fetch } }),
    ).rejects.toMatchObject({ name: "TransmitError", status: 400 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 503 then succeeds", async () => {
    const sleep = vi.fn(async () => {});
    let n = 0;
    const fetch = vi.fn(async () => {
      n += 1;
      return okResponse(n === 1 ? 503 : 204);
    });
    const result = await transmitEvidence({
      config: CONFIG,
      repository: "o/r",
      evidence: EVIDENCE,
      options: { fetch, sleep, retryBaseMs: 1 },
    });
    expect(result.status).toBe(204);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("retries a network error then succeeds", async () => {
    const sleep = vi.fn(async () => {});
    let n = 0;
    const fetch = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("ECONNRESET");
      return okResponse(204);
    });
    const result = await transmitEvidence({
      config: CONFIG,
      repository: "o/r",
      evidence: EVIDENCE,
      options: { fetch, sleep, retryBaseMs: 1 },
    });
    expect(result.status).toBe(204);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws TransmitError after exhausting the transient retry budget", async () => {
    const sleep = vi.fn(async () => {});
    const fetch = vi.fn(async () => okResponse(503));
    await expect(
      transmitEvidence({
        config: CONFIG,
        repository: "o/r",
        evidence: EVIDENCE,
        options: { fetch, sleep, maxRetries: 2, retryBaseMs: 1 },
      }),
    ).rejects.toMatchObject({ name: "TransmitError", status: 503 });
    expect(fetch).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
