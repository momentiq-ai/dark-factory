// Cycle 23 verifiable-objectives — the evidence TRANSMIT path. `df publish`
// already (a) uploads the `df verify` evidence bundle to Cerebe and (b) emits
// the `PublishedEvidence` pointer manifest. This module adds the missing third
// facet: PUSH that manifest to a configured HTTP evidence-ingest endpoint so a
// hosted worker can join it against `.darkfactory/objectives.yaml` without the
// consumer also having to ship the manifest out-of-band.
//
// Generic by design (Apache-2.0 / no platform coupling, mirroring cerebe.ts):
// the endpoint URL + shared secret come ENTIRELY from the environment
// (`DF_EVIDENCE_INGEST_URL` / `DF_EVIDENCE_INGEST_SECRET`). No hostnames, tenant
// model, or platform assumptions are baked in — any ingest endpoint that
// verifies a GitHub-style `X-Hub-Signature-256` HMAC over the raw body works.
//
// Wire contract (the receiver's half): POST a JSON envelope
//     { "repository": "<owner>/<repo>", "evidence": <PublishedEvidence> }
// with header `X-Hub-Signature-256: sha256=<hex>` where the digest is
// HMAC-SHA256(secret, RAW_REQUEST_BODY). The signature MUST be computed over the
// exact serialized bytes that are sent (the receiver recomputes over the raw
// body before parsing), so this module serializes once and signs+sends that
// same string.
//
// `resolveTransmitConfig` returns `null` when the env is absent — the caller
// degrades-and-passes (the merge verdict is NEVER blocked by transmit, exactly
// like an unconfigured Cerebe). `transmitEvidence` retries transient failures
// (5xx/429/network) and distinguishes a signature/auth rejection
// (`TransmitAuthError`, never retried) from a non-auth failure
// (`TransmitError`).

import { createHmac } from "node:crypto";

import type { PublishedEvidence } from "@momentiq/dark-factory-schemas";

/** Resolved transmit config. `null` from {@link resolveTransmitConfig} is the
 * "not configured" signal — the caller skips transmit and still exits 0. */
export interface TransmitConfig {
  /** DF_EVIDENCE_INGEST_URL — the full endpoint URL the manifest is POSTed to. */
  url: string;
  /** DF_EVIDENCE_INGEST_SECRET — the HMAC key (shared with the endpoint). */
  secret: string;
}

/** A signature/auth rejection (401/403). Distinct so the caller surfaces
 * "check DF_EVIDENCE_INGEST_SECRET" instead of retrying a doomed request. */
export class TransmitAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransmitAuthError";
  }
}

/** A non-auth transmit failure: a request-level 4xx (e.g. a 400 the endpoint
 * returns for a malformed/invalid manifest), an exhausted transient-retry
 * budget, or a network error. */
export class TransmitError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TransmitError";
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface TransmitOptions {
  // Injectable for tests; defaults to the global `fetch` (Node 18+ / undici).
  fetch?: FetchFn;
  maxRetries?: number; // default 2 (→ up to 3 attempts)
  retryBaseMs?: number; // default 500 (exponential)
  // Injectable so tests don't sleep on real time.
  sleep?: (ms: number) => Promise<void>;
}

/** Header + prefix the endpoint expects — GitHub webhook convention. */
export const SIGNATURE_HEADER = "x-hub-signature-256";
const SIGNATURE_PREFIX = "sha256=";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 500;

/** The POST envelope shape (the receiver narrows to exactly this). */
export interface TransmitEnvelope {
  repository: string;
  evidence: PublishedEvidence;
}

export interface TransmitResult {
  /** The HTTP status the endpoint returned (2xx ⇒ accepted; 204 may mean
   * accepted OR a server-side skip such as an unknown repo / no-pointer
   * manifest — the endpoint, not the CLI, makes that call). */
  status: number;
}

/**
 * Resolve transmit config from the environment. Returns `null` when either
 * DF_EVIDENCE_INGEST_URL or DF_EVIDENCE_INGEST_SECRET is missing/blank — the
 * fail-soft signal that the caller should skip transmit rather than error.
 */
export function resolveTransmitConfig(
  env: Record<string, string | undefined> = process.env,
): TransmitConfig | null {
  const url = (env["DF_EVIDENCE_INGEST_URL"] ?? "").trim();
  const secret = (env["DF_EVIDENCE_INGEST_SECRET"] ?? "").trim();
  if (url === "" || secret === "") return null;
  return { url, secret };
}

/**
 * Resolve the `repository` the envelope is attributed to: an explicit override
 * (`--repository owner/repo`) wins, else `GITHUB_REPOSITORY` (set by GitHub
 * Actions). Returns `null` when neither is available — the caller skips transmit
 * with a diagnostic (the receiver resolves tenancy from `repository`, so it is
 * required).
 */
export function resolveTransmitRepository(
  env: Record<string, string | undefined> = process.env,
  override?: string | null,
): string | null {
  const explicit = (override ?? "").trim();
  if (explicit !== "") return explicit;
  const fromEnv = (env["GITHUB_REPOSITORY"] ?? "").trim();
  return fromEnv !== "" ? fromEnv : null;
}

/**
 * Compute the canonical `sha256=<hex>` signature for a raw body + secret —
 * byte-identical to the receiver's verification (HMAC-SHA256 over the UTF-8
 * body, lowercase hex, `sha256=` prefix). Exposed for tests.
 */
export function computeSignature(secret: string, rawBody: string): string {
  return SIGNATURE_PREFIX + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/** Parse a `Retry-After` header (delta-seconds form) to ms, or undefined. */
function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get("retry-after");
  if (header === null) return undefined;
  const seconds = Number.parseInt(header.trim(), 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/**
 * POST the `{ repository, evidence }` envelope to the configured endpoint,
 * HMAC-signed. Throws {@link TransmitAuthError} on 401/403 (signature/secret
 * mismatch), {@link TransmitError} on a non-auth 4xx or an exhausted transient
 * retry budget. The CALLER is responsible for degrade-and-pass (catching these
 * so transmit never blocks the merge verdict).
 */
export async function transmitEvidence(args: {
  config: TransmitConfig;
  repository: string;
  evidence: PublishedEvidence;
  options?: TransmitOptions;
}): Promise<TransmitResult> {
  const { config, repository, evidence } = args;
  const opts = args.options ?? {};
  const fetchFn: FetchFn = opts.fetch ?? (globalThis.fetch as FetchFn);
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // Serialize ONCE and sign the exact bytes we send — the receiver recomputes
  // the HMAC over the raw request body before parsing.
  const rawBody = JSON.stringify({ repository, evidence } satisfies TransmitEnvelope);
  const signature = computeSignature(config.secret, rawBody);

  let lastError: TransmitError | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(config.url, {
        method: "POST",
        // Do NOT follow redirects: the signed body is single-use and bound to
        // THIS url's secret, so re-POSTing it to a 3xx target would be both
        // wrong (signature mismatch) and a body-disclosure risk. A 3xx surfaces
        // as a non-2xx below and is rejected.
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          [SIGNATURE_HEADER]: signature,
        },
        body: rawBody,
      });
    } catch (err) {
      // Network/transport error — retryable.
      lastError = new TransmitError(
        `network error transmitting evidence to ${config.url}: ${(err as Error).message}`,
      );
      if (attempt < maxRetries) {
        await sleep(retryBaseMs * 2 ** attempt);
        continue;
      }
      break;
    }

    if (res.status === 401 || res.status === 403) {
      throw new TransmitAuthError(
        `evidence-ingest endpoint rejected the signature (HTTP ${res.status}) — ` +
          `check DF_EVIDENCE_INGEST_SECRET matches the endpoint's secret.`,
      );
    }

    if (res.status === 429 || res.status >= 500) {
      // Transient — back off and retry, honoring Retry-After when present.
      lastError = new TransmitError(
        `evidence-ingest transient failure (HTTP ${res.status})`,
        res.status,
      );
      if (attempt < maxRetries) {
        await sleep(retryAfterMs(res) ?? retryBaseMs * 2 ** attempt);
        continue;
      }
      break;
    }

    if (res.status < 200 || res.status >= 300) {
      // Any other non-2xx that is neither transient (429/5xx, handled above) nor
      // auth (401/403, handled above) — including a 3xx redirect or a 4xx like
      // 400 (malformed/invalid manifest) — is a non-retryable failure. ONLY a
      // 2xx counts as an accepted transmit.
      throw new TransmitError(
        `evidence-ingest returned a non-2xx response (HTTP ${res.status}).`,
        res.status,
      );
    }

    // 2xx — accepted (or a server-side skip the endpoint signals via 204).
    return { status: res.status };
  }

  throw lastError ?? new TransmitError("evidence-ingest transmit failed (no response).");
}
