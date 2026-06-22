// Cycle 331.1 verifiable-objectives Phase 2 (momentiq-ai/dark-factory#207) —
// the Cerebe object-storage facade. A thin, typed wrapper over the Cerebe
// storage REST API, used by `df publish` to persist `df verify` evidence
// durably in CI.
//
// Why raw `fetch` instead of the `cerebe` SDK: the taxpilot2a facade
// (`backend/shared/services/storage.py`, the contract reference) wraps the
// Python SDK, but this CLI ships Apache-2.0 + air-gap-capable, so the publish
// path must (a) add no network-SDK dependency and (b) FAIL SOFT when Cerebe is
// not configured. The wire contract is pinned from cerebe-platform's server
// route + SDK: `POST /storage/upload` (multipart: file/session_id/user_id/
// purpose/tenant_id) authenticated by the `X-API-Key` header, → 201
// `{ upload_id, cdn_url, status, … }`.
//
// `resolveCerebeConfig` returns `null` when the env is absent — the caller
// degrades-and-passes rather than erroring (spec §5). `uploadFile` retries
// transient failures (5xx/429/network) and distinguishes an auth failure
// (`CerebeAuthError`, never retried) from an exhausted/unrecoverable upload
// (`CerebeUploadError`).

import { createHash } from "node:crypto";

// Resolved Cerebe connection config. A `null` result from `resolveCerebeConfig`
// is the "not configured" signal — the air-gap / OSS-baseline path.
export interface CerebeConfig {
  baseUrl: string; // CEREBE_API_URL, trailing slashes trimmed
  apiKey: string; // CEREBE_API_KEY → X-API-Key header
  project?: string; // optional CEREBE_PROJECT → X-Cerebe-Project header
}

export interface CerebeUploadInput {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
  // The server requires session_id + user_id multipart fields; the publish
  // orchestrator supplies CI-context values.
  sessionId: string;
  userId: string;
  purpose?: string; // default "general" (raw artifact, no memory bridging)
  tenantId?: string; // default "cerebe" (the server's own default)
}

export interface CerebeUploadResult {
  uploadId: string;
  // SHA-256 of the uploaded bytes (lowercase hex), computed locally — the
  // content-integrity digest carried into the pointer manifest.
  sha256: string;
  sizeBytes: number;
  contentType: string;
  cdnUrl?: string;
  status?: string;
}

// An authentication failure (401/403). Distinct from a transient error so the
// caller surfaces "check CEREBE_API_KEY" instead of retrying a doomed request.
export class CerebeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CerebeAuthError";
  }
}

// A non-auth upload failure: a request-level 4xx, an exhausted transient retry
// budget, or a malformed success response.
export class CerebeUploadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CerebeUploadError";
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface CerebeStorageOptions {
  // Injectable for tests; defaults to the global `fetch` (Node 18+ / undici).
  fetch?: FetchFn;
  maxRetries?: number; // default 3 (→ up to 4 attempts)
  retryBaseMs?: number; // default 500 (exponential)
  // Injectable so tests don't sleep on real time.
  sleep?: (ms: number) => Promise<void>;
}

// Resolve Cerebe config from the environment. Returns `null` when either
// CEREBE_API_URL or CEREBE_API_KEY is missing/blank — the fail-soft signal
// that publish should degrade rather than error (air-gap / OSS baseline).
export function resolveCerebeConfig(
  env: Record<string, string | undefined> = process.env,
): CerebeConfig | null {
  const baseUrl = (env["CEREBE_API_URL"] ?? "").trim();
  const apiKey = (env["CEREBE_API_KEY"] ?? "").trim();
  if (baseUrl === "" || apiKey === "") return null;
  const project = (env["CEREBE_PROJECT"] ?? "").trim();
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    ...(project !== "" ? { project } : {}),
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 500;

export class CerebeStorage {
  constructor(
    private readonly config: CerebeConfig,
    private readonly options: CerebeStorageOptions = {},
  ) {}

  async uploadFile(input: CerebeUploadInput): Promise<CerebeUploadResult> {
    const fetchFn: FetchFn = this.options.fetch ?? (globalThis.fetch as FetchFn);
    const maxRetries = this.options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryBaseMs = this.options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    const sleep =
      this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    const sha256 = sha256Hex(input.bytes);
    const sizeBytes = input.bytes.byteLength;
    const url = `${this.config.baseUrl}/storage/upload`;

    let lastError: CerebeUploadError | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let res: Response;
      try {
        res = await fetchFn(url, {
          method: "POST",
          headers: this.headers(),
          body: this.buildForm(input),
        });
      } catch (err) {
        // Network/transport error — retryable.
        lastError = new CerebeUploadError(
          `network error uploading ${input.filename}: ${(err as Error).message}`,
        );
        if (attempt < maxRetries) {
          await sleep(retryBaseMs * 2 ** attempt);
          continue;
        }
        break;
      }

      if (res.status === 401 || res.status === 403) {
        throw new CerebeAuthError(
          `Cerebe rejected the API key (HTTP ${res.status}) — check CEREBE_API_KEY.`,
        );
      }

      if (res.status === 429 || res.status >= 500) {
        // Transient — back off and retry, honoring Retry-After when present.
        lastError = new CerebeUploadError(`Cerebe upload failed (HTTP ${res.status})`, res.status);
        if (attempt < maxRetries) {
          await sleep(retryAfterMs(res) ?? retryBaseMs * 2 ** attempt);
          continue;
        }
        break;
      }

      if (!res.ok) {
        // A non-auth 4xx — a request-level problem; retrying won't help.
        throw new CerebeUploadError(
          `Cerebe upload failed (HTTP ${res.status}): ${await safeText(res)}`,
          res.status,
        );
      }

      const data = (await res.json().catch(() => ({}))) as {
        upload_id?: string;
        cdn_url?: string;
        status?: string;
      };
      if (!data.upload_id) {
        throw new CerebeUploadError(`Cerebe upload of ${input.filename} returned no upload_id`);
      }
      return {
        uploadId: data.upload_id,
        sha256,
        sizeBytes,
        contentType: input.contentType,
        ...(data.cdn_url ? { cdnUrl: data.cdn_url } : {}),
        ...(data.status ? { status: data.status } : {}),
      };
    }

    throw (
      lastError ??
      new CerebeUploadError(
        `Cerebe upload of ${input.filename} failed after ${maxRetries} retries`,
      )
    );
  }

  private headers(): Record<string, string> {
    return {
      "X-API-Key": this.config.apiKey,
      ...(this.config.project ? { "X-Cerebe-Project": this.config.project } : {}),
    };
  }

  private buildForm(input: CerebeUploadInput): FormData {
    const form = new FormData();
    // Native Blob/FormData (Node 18+ / undici): `fetch` sets the multipart
    // Content-Type + boundary itself, so `headers()` must NOT set it.
    // `as BlobPart`: a Uint8Array is a valid Blob part at runtime, but TS 5.7's
    // stricter `Uint8Array<ArrayBufferLike>` doesn't structurally match the
    // lib's `BlobPart` (which excludes SharedArrayBuffer-backed views).
    form.append(
      "file",
      new Blob([input.bytes as BlobPart], { type: input.contentType }),
      input.filename,
    );
    form.append("session_id", input.sessionId);
    form.append("user_id", input.userId);
    form.append("purpose", input.purpose ?? "general");
    form.append("tenant_id", input.tenantId ?? "cerebe");
    return form;
  }
}

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return undefined;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "<no body>";
  }
}
