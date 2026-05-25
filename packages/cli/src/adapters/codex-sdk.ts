// Cycle 322.7 — OpenAI Codex direct-SDK adapter via `@openai/codex-sdk`.
//
// Why a fourth adapter (manifesto §11 + §12): after 322.3 added the Grok
// critic the gate runs three vendor lineages (Cursor → OpenAI proxy,
// Gemini → Google, Grok → xAI), but the Cursor-routed GPT-5.5 critic
// empirically fails through Cursor's proxy capacity layer (Cursor support
// T-C42979, 2026-05-08 + 2026-05-11). A *direct* OpenAI critic via the
// Codex SDK closes that gap while exploiting the existing $200 ChatGPT
// Pro subscription instead of burning OpenAI API tokens per commit.
//
// The Codex SDK is a thin TypeScript wrapper around the `@openai/codex`
// CLI. The SDK spawns the CLI subprocess and exchanges JSONL events:
//   - `~/.codex/auth.json` holds the cached subscription OAuth token
//     (set up via `codex login`); the SDK subprocess inherits it.
//   - `CODEX_API_KEY` env supports API-key auth (the CI cold path).
//   - Critically, the SDK supports BOTH modes — declaring CODEX_API_KEY
//     in `requiredEnvVars` would force Doppler re-exec on every local
//     invocation even when subscription auth is the intended path.
//     Instead the adapter declares `requiredEnvVars = []` and the
//     doctor check validates AT LEAST ONE auth source is configured.
//
// The adapter:
//   - implements `CriticAdapter` from `critic.ts` (the post-322.2 shape
//     with `requiredEnvVars`)
//   - uses Codex's `outputSchema` parameter (passes a JSON Schema to the
//     model so the response in `Turn.finalResponse` is schema-validated
//     JSON natively — no `parseAssistantJson` fallback chain needed,
//     though we keep it as defense-in-depth for occasional format drift)
//   - mirrors the 322.1 retry shape (`runRetryLoop` + per-attempt
//     telemetry + permanent vs retryable failure classification) from a
//     single source of truth in `cursor-sdk.ts`, so the policy + budget
//     are byte-identical across adapters
//   - routes diagnostic-redaction + JSON parsing + reviewer-metadata
//     merge + error-result construction through `_shared.ts` so the
//     security boundary cannot drift
//   - is read-only by structure at THREE layers:
//       1. `sandboxMode: "read-only"` — the Codex CLI sandbox prevents
//          file writes
//       2. `approvalPolicy: "never"` — no interactive prompts
//       3. `networkAccessEnabled: false` — the agent cannot exfiltrate
//          diff content to external services
//     Note: even with all three knobs set, the Codex agent CAN execute
//     shell commands locally (read-only sandbox blocks WRITES, not
//     READS — the spike artifact captures one such command_execution).
//     This is acceptable because the agent runs over the diff under
//     review; the read-only sandbox prevents the agent from
//     modifying the repo state in any way.
//
// The implementation uses the dependency-injection ESCAPE hatch on the
// constructor (`createCodex` factory) so unit tests can supply a mock
// SDK that bypasses the real Codex CLI subprocess + network surface —
// this matches the testing posture of the 322.2 Gemini and 322.3 Grok
// adapters. The static import below pins `@openai/codex-sdk` as a hard
// dependency for production callers; tests still need the package
// resolvable at module-load time (so the static import succeeds) but
// the `createCodex` factory swap means tests never invoke the real
// Codex constructor or spawn the CLI subprocess. The doctor probe
// (`codex_sdk_loaded`) re-imports dynamically so a doctor run on a
// machine without the SDK installed surfaces a clear remediation
// instead of crashing at startup.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Codex } from "@openai/codex-sdk";

import { compileCriticPrompt } from "../prompt.js";
import {
  parseCriticResult,
  type CriticConfig,
  type CriticResult,
  type DoctorCheck,
  type ReviewPacket,
} from "@momentiq/dark-factory-schemas";

import { CRITIC_RESULT_JSON_SCHEMA } from "./critic-result-schema.js";
import type { CriticAdapter, CriticReviewOptions } from "./critic.js";
import {
  buildErrorResult,
  mergeAdapterMetadata,
  normalizeCriticEcho,
  parseAssistantJson,
  writeRedactedDiagnostic,
} from "./_shared.js";
import {
  PERMANENT_ERROR_CODES,
  runRetryLoop,
  type AttemptOutcome,
} from "./_retry.js";

// Promisified `execFile` for safe arg-array subprocess invocations.
// NB: this is `execFile` (no shell parsing), NOT `exec` — fixed arg
// arrays are immune to command injection. The codex doctor probe
// invokes `codex --version` via this helper.
const execFileAsync = promisify(execFile);

export const CODEX_SDK_ADAPTER_ID = "codex-sdk";
export const CODEX_API_KEY_ENV = "CODEX_API_KEY";
export const CODEX_HOME_ENV = "CODEX_HOME";

// Issue #2103 — auth-mode vocabulary the codex-sdk adapter accepts on
// `critic.auth` (set by `applyProfileAuth()` from
// `profile.auth[critic.id]`). Strict-no-fallback contract:
//
//   - "chatgpt": ChatGPT Pro / Plus / Business / Enterprise subscription
//     OAuth via `~/.codex/auth.json` (cached by `codex login`). The
//     adapter pins `forced_login_method: "chatgpt"` AND does NOT pass
//     `apiKey` to the SDK — so a stray `CODEX_API_KEY` in the env
//     cannot route the run through per-token API billing.
//
//   - "api": `CODEX_API_KEY` env var (developer API key). The adapter
//     pins `forced_login_method: "api"` and requires the env var to be
//     set; if missing, the adapter throws a permanent_failure at
//     attemptReview() — never falls back to subscription OAuth even if
//     `~/.codex/auth.json` exists.
//
// When `critic.auth` is undefined (no profile auth pin), the adapter
// throws a configuration error directing the operator to add
// `profiles.<name>.auth[<critic.id>]` to `.agent-review/config.json`.
// This is intentional: removing the old env-presence inference means
// the operator's intent must be declared, not inferred. The error
// message names the critic + profile so the fix is mechanical.
export const CODEX_AUTH_CHATGPT = "chatgpt" as const;
export const CODEX_AUTH_API = "api" as const;
export type CodexAuthMode = typeof CODEX_AUTH_CHATGPT | typeof CODEX_AUTH_API;
export const CODEX_AUTH_MODES: readonly CodexAuthMode[] = [
  CODEX_AUTH_CHATGPT,
  CODEX_AUTH_API,
];

// ---------------------------------------------------------------------------
// Bundled-binary resolution (#1471 P2 #2)
//
// The Codex SDK bundles the `codex` CLI as an `optionalDependency` on the
// `@openai/codex` npm package (which itself optional-depends on per-platform
// binary packages like `@openai/codex-linux-x64`, `@openai/codex-darwin-arm64`).
// A standard `npm ci` from `tools/agent-review/` puts the platform binary on
// disk at `node_modules/@openai/codex-<platform>-<arch>/vendor/<target>/codex/codex`
// without putting `codex` on PATH. The SDK itself resolves this binary
// internally via `findCodexPath()` (private to the SDK package; not exported).
//
// This helper mirrors the SDK's resolution so the doctor probe can probe the
// SAME binary the SDK will spawn at review time. Falls back to returning
// `null` when any step of the resolution fails (no @openai/codex package,
// unsupported platform, missing platform package), and the doctor then falls
// back to probing the PATH `codex` binary.

const CODEX_NPM_NAME = "@openai/codex";

const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

/**
 * Compute the (platform, arch) target triple Codex uses to key its
 * per-platform binary packages. Returns `null` for unsupported platforms.
 * Exported for direct unit testing of the resolution logic.
 */
export function targetTripleForCurrentPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  switch (platform) {
    case "linux":
    case "android":
      if (arch === "x64") return "x86_64-unknown-linux-musl";
      if (arch === "arm64") return "aarch64-unknown-linux-musl";
      return null;
    case "darwin":
      if (arch === "x64") return "x86_64-apple-darwin";
      if (arch === "arm64") return "aarch64-apple-darwin";
      return null;
    case "win32":
      if (arch === "x64") return "x86_64-pc-windows-msvc";
      if (arch === "arm64") return "aarch64-pc-windows-msvc";
      return null;
    default:
      return null;
  }
}

/**
 * Resolve the absolute path to the Codex CLI binary bundled inside
 * `@openai/codex`'s per-platform optional dependency. Returns `null` when
 * any step of the resolution fails (so the doctor can fall back to PATH).
 *
 * Mirrors `findCodexPath()` in `@openai/codex-sdk@0.130.0` —
 * `node_modules/@openai/codex-sdk/dist/index.js:368-433`. The SDK does
 * not export this function publicly, so we replicate the lookup here
 * using the same `createRequire` + `package.json` walk so the doctor
 * probes the EXACT binary the SDK will spawn at review time.
 */
export function resolveBundledCodexCliPath(): string | null {
  const targetTriple = targetTripleForCurrentPlatform();
  if (!targetTriple) return null;
  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[targetTriple];
  if (!platformPackage) return null;
  // `createRequire(import.meta.url)` returns a `require` rooted at THIS
  // compiled module. The SDK's `@openai/codex` direct dep is reachable
  // from us because `@openai/codex-sdk` is OUR direct dep and `@openai/codex`
  // is the SDK's direct dep. npm's hoisting algorithm lifts both into our
  // node_modules tree so the resolution walk succeeds.
  try {
    const moduleRequire = createRequire(import.meta.url);
    const codexPackageJsonPath = moduleRequire.resolve(`${CODEX_NPM_NAME}/package.json`);
    const codexRequire = createRequire(codexPackageJsonPath);
    const platformPackageJsonPath = codexRequire.resolve(`${platformPackage}/package.json`);
    const vendorRoot = path.join(path.dirname(platformPackageJsonPath), "vendor");
    const codexBinaryName = process.platform === "win32" ? "codex.exe" : "codex";
    const binaryPath = path.join(vendorRoot, targetTriple, "codex", codexBinaryName);
    return existsSync(binaryPath) ? binaryPath : null;
  } catch {
    return null;
  }
}

/**
 * Outcome of probing `codex login status`. `loggedIn: true` matches
 * exit-0 from the CLI regardless of where credentials are stored
 * (~/.codex/auth.json vs OS keyring), which is the canonical detector
 * for #1471 P2 #1.
 */
export interface CodexAuthProbeOutcome {
  loggedIn: boolean;
  detail: string;
}

/**
 * Subprocess hook used by {@link probeCodexLoginStatus}. Production passes
 * the promisified `child_process.execFile`; tests pass a mock so the
 * probe can be exercised hermetically. Mirrors the same shape as the
 * `execCodex` option on {@link CodexSdkAdapterOptions}.
 */
export type CodexExecHook = (
  binaryPath: string,
  args: readonly string[],
  options?: { timeout?: number },
) => Promise<{ stdout: string }>;

/**
 * Probe `codex login status` to detect authenticated state regardless of
 * where credentials are stored (~/.codex/auth.json or OS keyring per
 * `cli_auth_credentials_store: auto`). The CLI exits 0 when authenticated
 * and non-zero when not, which is the canonical detector for #1471 P2 #1.
 *
 * The `exec` parameter defaults to the promisified `child_process.execFile`
 * but accepts a test override so the probe can be invoked deterministically.
 *
 * Exported and used by {@link CodexSdkAdapter.doctor} (the doctor's
 * `defaultAuthProbe` routes here with its `execCodex` hook injected).
 */
export async function probeCodexLoginStatus(
  cliPath: string,
  exec: CodexExecHook = (binaryPath, args, options) =>
    execFileAsync(binaryPath, args as string[], options ?? {}),
  timeoutMs = 5_000,
): Promise<CodexAuthProbeOutcome> {
  try {
    const { stdout } = await exec(cliPath, ["login", "status"], {
      timeout: timeoutMs,
    });
    return { loggedIn: true, detail: stdout.trim() || "codex login status: ok" };
  } catch (err) {
    const e = err as Error;
    return { loggedIn: false, detail: `codex login status failed: ${e.message}` };
  }
}

// Reasoning-effort param id used in `critic.model.params`; mapped to
// Codex's `model_reasoning_effort` CLI config key inside the adapter.
const REASONING_EFFORT_PARAM_ID = "reasoning_effort";

// Allowed Codex reasoning-effort values per the SDK's ModelReasoningEffort
// union (`@openai/codex-sdk` 0.130 exports: "minimal" | "low" | "medium"
// | "high" | "xhigh"). Codex docs note `xhigh` is model-dependent; the
// default of `high` is universally supported.
const ALLOWED_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
export const DEFAULT_REASONING_EFFORT = "high" as const;

// ---------------------------------------------------------------------------
// Test surface

/**
 * Test-shape compatible with the `@openai/codex-sdk` Codex / Thread
 * classes. The unit tests pass a mock conforming to this shape; production
 * passes the real `new Codex({ config: ... })` instance through the
 * `createCodex` factory on the adapter constructor.
 *
 * The shape stays narrow on purpose — the adapter uses ONLY the methods
 * declared here, so an SDK upgrade that re-shapes other surfaces won't
 * silently break the adapter.
 */
export interface CodexClient {
  startThread: (options: CodexThreadOptions) => CodexThread;
}

export interface CodexThread {
  /** Populated after the first turn starts. */
  readonly id: string | null;
  run: (
    prompt: string,
    options: { outputSchema?: unknown; signal?: AbortSignal },
  ) => Promise<CodexTurnResult>;
}

export interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export interface CodexTurnResult {
  items: unknown[];
  /** Last agent_message text; schema-validated JSON when outputSchema is set. */
  finalResponse: string;
  usage: CodexUsage | null;
}

/**
 * Thread-construction options the adapter sets when starting a turn.
 * Mirrors `ThreadOptions` in `@openai/codex-sdk` but typed locally so
 * the SDK is not required at compile time for test environments that
 * use the mock factory.
 */
export interface CodexThreadOptions {
  model?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
  modelReasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  networkAccessEnabled?: boolean;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
}

/**
 * Top-level streamed events (mirrors the SDK's `ThreadEvent` union).
 * Currently unused by the adapter — `thread.run()` returns a `Turn`
 * directly without a stream — but exported so future event-aware
 * adapters and tests can lean on a stable type surface.
 */
export type CodexThreadEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "turn.completed"; usage: CodexUsage }
  | { type: "turn.failed"; error: { message: string } }
  | { type: "item.started"; item: unknown }
  | { type: "item.updated"; item: unknown }
  | { type: "item.completed"; item: unknown }
  | { type: "error"; message: string };

export interface CodexSdkAdapterOptions {
  /**
   * Override CODEX_API_KEY env. Production reads from `process.env` —
   * the constructor option is a test escape hatch.
   */
  apiKey?: string;
  /**
   * Override `CODEX_HOME` for the auth.json doctor probe. Production
   * reads from env or defaults to `~/.codex`.
   */
  codexHome?: string;
  /**
   * Test escape hatch — inject a mock Codex client. Production builds
   * the real `new Codex({...})` each `review()` call (one client per
   * call is a no-op since the SDK is a thin wrapper that lazily spawns
   * the CLI per `thread.run()`).
   */
  createCodex?: (options: {
    apiKey?: string;
    config?: Record<string, unknown>;
  }) => CodexClient;
  /**
   * Test escape hatch for the retry-loop sleep. When unset the adapter
   * uses the real `sleepForRetry` (wall-clock + AbortSignal-aware).
   * Mirrors the same hook on `runRetryLoop` so tests don't have to wait
   * for 5s + 15s of real backoff to exercise retry behavior.
   */
  sleep?: (idx: number, signal: AbortSignal | undefined) => Promise<void>;
  /**
   * Test escape hatch for the bundled-binary resolver (#1471 P2 #2).
   * Production uses {@link resolveBundledCodexCliPath} to mirror the SDK's
   * `findCodexPath()` lookup. Tests pass a lambda returning `null` (to
   * exercise the PATH-fallback path) or a fake absolute path (to assert
   * the resolved binary is what gets probed).
   */
  codexCliPathResolver?: () => string | null;
  /**
   * Test escape hatch for the `execFile` subprocess invocation
   * (#1492 + #1471 P2 #2). Production uses the promisified
   * `child_process.execFile`. Tests pass a mock to (a) avoid spawning the
   * real `codex` binary and (b) assert WHICH binary path the doctor
   * probes.
   *
   * `args` is a fixed string-array (no shell parsing). Throw an Error with
   * `code: "ENOENT"` to simulate a missing-binary failure (same shape
   * `execFile` produces against an unresolved command).
   */
  execCodex?: (
    binaryPath: string,
    args: readonly string[],
    options?: { timeout?: number },
  ) => Promise<{ stdout: string }>;
  /**
   * Test escape hatch for the `codex login status` probe (#1471 P2 #1).
   *
   * In production, `doctor()` builds a `defaultAuthProbe` that delegates
   * to the exported {@link probeCodexLoginStatus}, passing the same
   * `execCodex` hook the rest of the doctor uses so the entire
   * subprocess surface is uniformly mockable. The probed binary is the
   * bundled one when resolvable, falling back to PATH `codex` — the
   * same binary the SDK spawns at review time, so the doctor verdict
   * reflects runtime truth.
   *
   * Tests pass a lambda returning `{ loggedIn: true|false, detail: string }`
   * to exercise the doctor's three-way auth check (env / file /
   * keyring-via-status) hermetically without spawning the CLI.
   */
  codexAuthProbe?: () => Promise<CodexAuthProbeOutcome>;
}

/**
 * Resolve the Codex reasoning-effort from the critic config's
 * `model.params`. Falls back to {@link DEFAULT_REASONING_EFFORT} when
 * unset. Invalid values fall back to the default rather than corrupting
 * the request body. Coerces string inputs (the config schema's `value`
 * is `string | number | boolean`; reasoning effort is always a string
 * enum). Exported for direct unit testing.
 */
export function resolveCodexReasoningEffort(critic: CriticConfig): string {
  const param = critic.model.params.find((p) => p.id === REASONING_EFFORT_PARAM_ID);
  if (!param) return DEFAULT_REASONING_EFFORT;
  const v = param.value;
  if (typeof v !== "string") return DEFAULT_REASONING_EFFORT;
  const norm = v.toLowerCase();
  if (ALLOWED_REASONING_EFFORTS.has(norm)) return norm;
  return DEFAULT_REASONING_EFFORT;
}

/**
 * Probe a thrown error for a Codex SDK structured error code. The
 * Codex SDK surfaces errors as plain `Error` instances; some SDK
 * upgrades add a `code` field (mirroring openai's `APIError.code`).
 * The adapter treats:
 *   - `code` matching {@link PERMANENT_ERROR_CODES} → permanent
 *   - everything else → retryable
 * Exported for unit testing.
 */
export function extractCodexErrorCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Record<string, unknown>;
  if (typeof e["code"] === "string") return e["code"];
  // Some SDK shapes nest under `cause.code`:
  const cause = e["cause"];
  if (cause && typeof cause === "object") {
    const c = (cause as Record<string, unknown>)["code"];
    if (typeof c === "string") return c;
  }
  return null;
}

/**
 * Issue #2103 — strict auth resolver. Validates `critic.auth` against
 * the codex adapter vocabulary ({@link CODEX_AUTH_MODES}) and surfaces
 * the missing-key case as a `permanent_failure` so the outer retry
 * loop returns the error immediately (retrying a configuration
 * mistake just wastes budget). Returns the resolved mode + an
 * `apiKey` value that is INTENTIONALLY `undefined` under the
 * "chatgpt" branch so the caller passes nothing to the SDK
 * constructor — a stray `CODEX_API_KEY` cannot override the
 * subscription path.
 *
 * Three failure shapes, all permanent (no retry):
 *
 *   1. `critic.auth === undefined`: profile didn't pin auth. Surfaces
 *      as `permanent_failure` with a message naming the critic + the
 *      config path the operator should edit
 *      (`profiles.<name>.auth[<critic.id>]`).
 *
 *   2. `critic.auth` is set but not in {@link CODEX_AUTH_MODES}:
 *      typo / unsupported value. The error message enumerates the
 *      valid set so the operator can self-correct.
 *
 *   3. `critic.auth === "api"` AND no `CODEX_API_KEY` in env (and no
 *      `apiKey` constructor override): the configured source is
 *      missing. Same shape as the prior "missing key" path, with the
 *      error explicitly mentioning the `api` auth mode so the
 *      operator doesn't try to fix it by running `codex login`.
 */
export function resolveAuthOrFail(
  critic: CriticConfig,
  options: { apiKey?: string },
  attemptIdx: number,
): { kind: "ok"; mode: CodexAuthMode; apiKey: string | undefined } | Extract<AttemptOutcome, { kind: "permanent_failure" }> {
  const authRaw = critic.auth;
  if (authRaw === undefined) {
    return {
      kind: "permanent_failure",
      errorCode: null,
      statusMessage: null,
      result: buildErrorResult({
        critic,
        message:
          `codex critic "${critic.id}" has no auth source pinned. ` +
          `Add \`profiles.<name>.auth["${critic.id}"]\` to .agent-review/config.json ` +
          `with one of: ${CODEX_AUTH_MODES.join(", ")}. ` +
          `(Issue #2103 — env-presence inference was removed to prevent silent fallback to API-key billing.)`,
        retryable: false,
        retryCount: attemptIdx,
      }),
    };
  }
  if (!(CODEX_AUTH_MODES as readonly string[]).includes(authRaw)) {
    return {
      kind: "permanent_failure",
      errorCode: null,
      statusMessage: null,
      result: buildErrorResult({
        critic,
        message:
          `codex critic "${critic.id}" has unsupported auth value "${authRaw}". ` +
          `Expected one of: ${CODEX_AUTH_MODES.join(", ")}. ` +
          `Edit \`profiles.<name>.auth["${critic.id}"]\` in .agent-review/config.json.`,
        retryable: false,
        retryCount: attemptIdx,
      }),
    };
  }
  const mode = authRaw as CodexAuthMode;
  if (mode === CODEX_AUTH_API) {
    const apiKey = options.apiKey ?? process.env[CODEX_API_KEY_ENV];
    if (!apiKey) {
      return {
        kind: "permanent_failure",
        errorCode: null,
        statusMessage: null,
        result: buildErrorResult({
          critic,
          message:
            `codex critic "${critic.id}" is pinned to auth="api" but ${CODEX_API_KEY_ENV} is not set. ` +
            `Either provision the key (e.g. via Doppler) or change the profile to auth="${CODEX_AUTH_CHATGPT}" and run \`codex login\`.`,
          retryable: false,
          retryCount: attemptIdx,
        }),
      };
    }
    return { kind: "ok", mode, apiKey };
  }
  // mode === "chatgpt" — withhold apiKey so a stray env var cannot
  // override subscription auth at the SDK level.
  return { kind: "ok", mode, apiKey: undefined };
}

export class CodexSdkAdapter implements CriticAdapter {
  readonly id = CODEX_SDK_ADAPTER_ID;
  // Cycle 322.7 — empty array because the Codex SDK supports BOTH auth modes:
  //   - Local: ~/.codex/auth.json from `codex login` (ChatGPT subscription OAuth)
  //   - CI:    CODEX_API_KEY env var (OpenAI API key)
  // doctor() validates that at least ONE is configured; the SDK subprocess
  // inherits whichever is present. Declaring CODEX_API_KEY as "required"
  // here would force Doppler re-exec even when subscription auth is the
  // intended path.
  readonly requiredEnvVars: readonly string[] = [];

  private readonly createCodex: (options: {
    apiKey?: string;
    config?: Record<string, unknown>;
  }) => CodexClient;

  constructor(private readonly options: CodexSdkAdapterOptions = {}) {
    this.createCodex =
      options.createCodex ??
      ((opts) =>
        new Codex({
          ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
          ...(opts.config !== undefined
            ? { config: opts.config as Record<string, string | number | boolean> }
            : {}),
        }) as unknown as CodexClient);
  }

  async review(
    packet: ReviewPacket,
    critic: CriticConfig,
    options: CriticReviewOptions,
  ): Promise<CriticResult> {
    return runRetryLoop({
      attempt: (idx) => this.attemptReview(packet, critic, options, idx),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(this.options.sleep !== undefined ? { sleep: this.options.sleep } : {}),
      buildExhausted: ({ last, totalAttempts, aborted }) => {
        const retriesUsed = Math.max(0, totalAttempts - 1);
        const summary = aborted
          ? last
            ? `codex SDK run aborted after ${retriesUsed} retries: ${last.message}`
            : "codex SDK run aborted before any attempt completed"
          : last
            ? `codex SDK run failed after ${retriesUsed} retries: ${last.message}`
            : "codex SDK run failed with no captured failure metadata";
        return buildErrorResult({
          critic,
          message: summary,
          retryable: true,
          ...(last?.errorCode != null ? { code: last.errorCode } : {}),
          retryCount: retriesUsed,
          ...(last?.runId !== null && last?.runId !== undefined
            ? { runId: last.runId }
            : {}),
          ...(last?.agentId !== null && last?.agentId !== undefined
            ? { agentId: last.agentId }
            : {}),
        });
      },
    });
  }

  private async attemptReview(
    packet: ReviewPacket,
    critic: CriticConfig,
    options: CriticReviewOptions,
    attemptIdx: number,
  ): Promise<AttemptOutcome> {
    const reasoningEffort = resolveCodexReasoningEffort(critic);

    // Issue #2103 — strict-no-fallback auth resolution. The runner sets
    // `critic.auth` via `applyProfileAuth()` from
    // `profile.auth[critic.id]`; this adapter honors it without
    // env-presence inference.
    //
    //   - "chatgpt": pin `forced_login_method: "chatgpt"` AND withhold
    //     `apiKey` from the SDK — so even if `CODEX_API_KEY` is set in
    //     the env (Doppler leaks the CI key into local shells), the
    //     SDK falls through to `~/.codex/auth.json` and bills against
    //     the ChatGPT Pro subscription quota.
    //
    //   - "api": pin `forced_login_method: "api"` and REQUIRE
    //     `CODEX_API_KEY` (or the `apiKey` constructor override for
    //     tests). Missing key returns `permanent_failure` immediately;
    //     no fallback to subscription OAuth.
    //
    //   - undefined: configuration error. The operator must declare
    //     auth at the profile level (see CLAUDE.md / issue #2103). The
    //     adapter throws `permanent_failure` naming the critic so the
    //     fix is mechanical (add `profiles.<name>.auth[<critic.id>]`).
    const authResolved = resolveAuthOrFail(critic, this.options, attemptIdx);
    if (authResolved.kind === "permanent_failure") return authResolved;
    const { mode: forcedLoginMethod, apiKey } = authResolved;

    const prompt = compileCriticPrompt({
      packet,
      critic,
      blockingSeverities: options.blockingSeverities,
      treatDiffAsUntrusted: true,
    });

    const startMs = Date.now();
    if (attemptIdx === 0) {
      options.emit?.({
        ts: new Date().toISOString(),
        event: "critic_run_started",
        commit: packet.commit.sha,
        criticId: critic.id,
        adapter: this.id,
        model: critic.model.id,
      });
    }

    let codex: CodexClient;
    try {
      codex = this.createCodex({
        ...(apiKey !== undefined ? { apiKey } : {}),
        config: {
          model: critic.model.id,
          // Codex CLI key. Pinned via the constructor `config` map which
          // the SDK serializes into `--config key=value` CLI overrides.
          model_reasoning_effort: reasoningEffort,
          // Reasoning tokens are model-internal; surfacing them in the
          // event stream just bloats artifacts.
          show_raw_agent_reasoning: false,
          // Belt-and-suspenders against a stray CODEX_API_KEY clobbering
          // the intended subscription path (or vice versa).
          forced_login_method: forcedLoginMethod,
        },
      });
    } catch (err) {
      const e = err as Error;
      options.emit?.({
        ts: new Date().toISOString(),
        event: "critic_run_error",
        commit: packet.commit.sha,
        criticId: critic.id,
        adapter: this.id,
        model: critic.model.id,
        durationMs: Date.now() - startMs,
        error: e.message,
        status: "startup_failure",
        retryCount: attemptIdx,
      });
      return {
        kind: "retryable_failure",
        errorCode: null,
        statusMessage: null,
        message: `codex SDK construction failed: ${e.message}`,
        runId: null,
        agentId: null,
      };
    }

    let thread: CodexThread;
    try {
      thread = codex.startThread({
        workingDirectory: packet.repoRoot,
        // Defense in depth — critic must never write files even if a
        // malicious diff convinces the model to try. Read-only sandbox
        // blocks WRITES, not READS, so the agent may still run shell
        // commands to explore the repo (see fixtures/spike-codex-2026-05.json).
        sandboxMode: "read-only",
        // No interactive prompts in non-interactive runs.
        approvalPolicy: "never",
        // Critic must not exfiltrate diff content to external services.
        networkAccessEnabled: false,
        // packet.repoRoot IS a git repo; let the CLI confirm.
        skipGitRepoCheck: false,
      });
    } catch (err) {
      const e = err as Error;
      options.emit?.({
        ts: new Date().toISOString(),
        event: "critic_run_error",
        commit: packet.commit.sha,
        criticId: critic.id,
        adapter: this.id,
        model: critic.model.id,
        durationMs: Date.now() - startMs,
        error: e.message,
        status: "startup_failure",
        retryCount: attemptIdx,
      });
      return {
        kind: "retryable_failure",
        errorCode: null,
        statusMessage: null,
        message: `codex startThread failed: ${e.message}`,
        runId: null,
        agentId: null,
      };
    }

    let turn: CodexTurnResult;
    try {
      turn = await thread.run(prompt.text, {
        outputSchema: CRITIC_RESULT_JSON_SCHEMA,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (err) {
      const e = err as Error;
      const codeStr = extractCodexErrorCode(err);
      // Permanent codes are the same classification used by the Cursor
      // adapter: auth/quota/policy failures where retrying wastes
      // budget AND can mask the real fault.
      const permanent = codeStr !== null && PERMANENT_ERROR_CODES.has(codeStr);
      const finalCode = codeStr ?? "transport_error";
      options.emit?.({
        ts: new Date().toISOString(),
        event: "critic_run_error",
        commit: packet.commit.sha,
        criticId: critic.id,
        adapter: this.id,
        model: critic.model.id,
        durationMs: Date.now() - startMs,
        error: e.message,
        status: permanent ? "run_failure_permanent" : "run_failure",
        retryCount: attemptIdx,
        errorCode: finalCode,
        ...(thread.id !== null ? { runId: thread.id } : {}),
      });
      if (permanent) {
        return {
          kind: "permanent_failure",
          errorCode: finalCode,
          statusMessage: null,
          result: buildErrorResult({
            critic,
            message: `codex SDK run failed (permanent, code=${finalCode}): ${e.message}`,
            retryable: false,
            code: finalCode,
            retryCount: attemptIdx,
            ...(thread.id !== null ? { runId: thread.id } : {}),
          }),
        };
      }
      return {
        kind: "retryable_failure",
        errorCode: finalCode,
        statusMessage: null,
        message: `codex SDK run failed: ${e.message}`,
        runId: thread.id,
        agentId: null,
      };
    }

    // Parse path. With `outputSchema` set, Codex enforces schema-validated
    // JSON at the model level; the `parseAssistantJson` fallback chain is
    // defense in depth against occasional format drift in older models or
    // SDK regressions.
    const parseOutcome = parseAssistantJson(turn.finalResponse);
    if (!parseOutcome.ok) {
      const diagPath = writeRedactedDiagnostic({
        diagnosticsDir: options.diagnosticsDir,
        criticId: critic.id,
        commit: packet.commit.sha,
        rawText: turn.finalResponse,
      });
      options.emit?.({
        ts: new Date().toISOString(),
        event: "critic_run_error",
        commit: packet.commit.sha,
        criticId: critic.id,
        adapter: this.id,
        model: critic.model.id,
        durationMs: Date.now() - startMs,
        error: `invalid critic JSON: ${parseOutcome.message}`,
        status: "invalid_json",
        retryCount: attemptIdx,
        ...(thread.id !== null ? { runId: thread.id } : {}),
      });
      return {
        kind: "permanent_failure",
        errorCode: null,
        statusMessage: null,
        result: buildErrorResult({
          critic,
          message: `codex critic returned invalid JSON: ${parseOutcome.message}`,
          retryable: false,
          ...(diagPath !== undefined ? { rawSamplePath: diagPath } : {}),
          ...(thread.id !== null ? { runId: thread.id } : {}),
          retryCount: attemptIdx,
        }),
      };
    }

    let result: CriticResult;
    try {
      // Drop schema-invalid `validation.qualityGateResults[]` entries
      // (e.g. model emits `gate` instead of `command`) BEFORE strict
      // parsing — the validation block is informational and gets
      // overwritten below with deterministic packet evidence. Issue #1484.
      const normalized = normalizeCriticEcho(parseOutcome.value);
      const enriched = mergeAdapterMetadata(normalized, {
        critic,
        ...(thread.id !== null ? { runId: thread.id } : {}),
      });
      result = parseCriticResult(enriched, options.blockingSeverities);
    } catch (err) {
      const e = err as Error;
      const diagPath = writeRedactedDiagnostic({
        diagnosticsDir: options.diagnosticsDir,
        criticId: critic.id,
        commit: packet.commit.sha,
        rawText: turn.finalResponse,
      });
      options.emit?.({
        ts: new Date().toISOString(),
        event: "critic_run_error",
        commit: packet.commit.sha,
        criticId: critic.id,
        adapter: this.id,
        model: critic.model.id,
        durationMs: Date.now() - startMs,
        error: `schema validation failed: ${e.message}`,
        status: "schema_violation",
        retryCount: attemptIdx,
        ...(thread.id !== null ? { runId: thread.id } : {}),
      });
      return {
        kind: "permanent_failure",
        errorCode: null,
        statusMessage: null,
        result: buildErrorResult({
          critic,
          message: `codex critic JSON failed schema validation: ${e.message}`,
          retryable: false,
          ...(diagPath !== undefined ? { rawSamplePath: diagPath } : {}),
          ...(thread.id !== null ? { runId: thread.id } : {}),
          retryCount: attemptIdx,
        }),
      };
    }

    const durationMs = Date.now() - startMs;
    const enriched: CriticResult = {
      ...result,
      durationMs,
      validation: {
        qualityGateResults: packet.validation.evidence,
        qualityGatesMissing: packet.validation.missing,
      },
    };
    const blockerCount = enriched.findings.filter((f) => f.severity === "blocker").length;
    const highCount = enriched.findings.filter((f) => f.severity === "high").length;

    options.emit?.({
      ts: new Date().toISOString(),
      event: "critic_run_finished",
      commit: packet.commit.sha,
      criticId: critic.id,
      adapter: this.id,
      model: critic.model.id,
      ...(thread.id !== null ? { runId: thread.id } : {}),
      durationMs,
      ...(enriched.verdict !== undefined ? { verdict: enriched.verdict } : {}),
      findingCount: enriched.findings.length,
      blockerCount,
      highCount,
      ...(typeof turn.usage?.input_tokens === "number"
        ? { tokensIn: turn.usage.input_tokens }
        : {}),
      ...(typeof turn.usage?.output_tokens === "number"
        ? { tokensOut: turn.usage.output_tokens }
        : {}),
      status: "complete",
      retryCount: attemptIdx,
    });

    return { kind: "success", result: enriched };
  }

  async doctor(critic: CriticConfig): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const apiKey = this.options.apiKey ?? process.env[CODEX_API_KEY_ENV];
    const codexHome =
      this.options.codexHome ?? process.env[CODEX_HOME_ENV] ?? path.join(os.homedir(), ".codex");
    const authPath = path.join(codexHome, "auth.json");
    const authExists = existsSync(authPath);

    // Cycle 322.7 follow-up #1492 + #1471 P2 #2: probe the BUNDLED Codex
    // CLI binary (resolved via `@openai/codex` optional dep) before
    // falling back to PATH. The SDK uses the bundled binary internally
    // via `findCodexPath()` (not exported), so probing the same binary
    // here is the only way for the doctor to reflect the SDK's runtime
    // truth on a fresh `npm ci`-only install (no `npm install -g`).
    //
    // Resolution precedence:
    //   1. `options.codexCliPathResolver` (test hook)
    //   2. `resolveBundledCodexCliPath()` (production: walks
    //      @openai/codex package + platform-specific binary package)
    //   3. PATH literal `codex` (fallback for workstations using
    //      `brew install codex` or `npm install -g @openai/codex`)
    const resolveBundled = this.options.codexCliPathResolver ?? resolveBundledCodexCliPath;
    const bundledPath = resolveBundled();
    const execCodex =
      this.options.execCodex ??
      ((binaryPath: string, args: readonly string[], opts?: { timeout?: number }) =>
        execFileAsync(binaryPath, args as string[], opts ?? {}));

    // Cycle 322.7 follow-up #1471 P2 #1: probe `codex login status` to
    // detect keyring-backed auth. The default probe delegates to the
    // exported `probeCodexLoginStatus`, passing the SAME `execCodex`
    // hook so test overrides apply uniformly. The probed binary is the
    // bundled one when resolvable, falling back to PATH `codex` — the
    // same binary the SDK will spawn at review time, so the doctor's
    // verdict reflects runtime truth. Skipped (treated as
    // `loggedIn: false` with informational detail) when no codex
    // binary is resolvable at all — the codex_cli_on_path check below
    // will surface that as the actionable failure.
    const defaultAuthProbe = (): Promise<CodexAuthProbeOutcome> =>
      probeCodexLoginStatus(bundledPath ?? "codex", execCodex);
    const authProbe = this.options.codexAuthProbe ?? defaultAuthProbe;
    const authProbeOutcome = await authProbe();

    // Issue #2103 — strict auth check honors `critic.auth` when set:
    //   - "chatgpt": ONLY subscription sources count (file or keyring).
    //     A stray CODEX_API_KEY in the env does NOT pass the check —
    //     the whole point of the pin is to surface "subscription auth
    //     is not actually configured here" so the operator fixes it
    //     instead of silently routing to API billing.
    //   - "api": ONLY CODEX_API_KEY counts. Subscription presence is
    //     ignored (it would mislead the operator into thinking they're
    //     set up for CI when they aren't).
    //   - undefined (no profile context, direct adapter usage, tests):
    //     legacy "AT LEAST ONE of three sources" — preserves
    //     back-compat for non-profile call sites.
    //
    // The detail string discloses which path is active so operators
    // can debug "I logged in but doctor still says missing".
    const subscriptionActive = authExists || authProbeOutcome.loggedIn;
    let hasAuth: boolean;
    let authDetail: string;
    let authRemediation: string;
    if (critic.auth === CODEX_AUTH_CHATGPT) {
      hasAuth = subscriptionActive;
      if (authExists) {
        authDetail = `${authPath} exists (subscription auth, file-backed; auth=${CODEX_AUTH_CHATGPT})`;
      } else if (authProbeOutcome.loggedIn) {
        authDetail = `codex login status reports authenticated (keyring-backed; auth=${CODEX_AUTH_CHATGPT}): ${authProbeOutcome.detail}`;
      } else {
        authDetail = `critic pinned to auth="${CODEX_AUTH_CHATGPT}" but no subscription source: ${authPath} missing; ${authProbeOutcome.detail}`;
      }
      authRemediation = `run \`codex login\` once on this workstation to authenticate the ChatGPT Pro/Plus/Business/Enterprise subscription (supports keyring or ${authPath} depending on cli_auth_credentials_store)`;
    } else if (critic.auth === CODEX_AUTH_API) {
      hasAuth = Boolean(apiKey);
      authDetail = apiKey
        ? `${CODEX_API_KEY_ENV} set (API-key auth; auth=${CODEX_AUTH_API})`
        : `critic pinned to auth="${CODEX_AUTH_API}" but ${CODEX_API_KEY_ENV} is unset`;
      authRemediation = `export ${CODEX_API_KEY_ENV}=... (typically via Doppler for the CI profile)`;
    } else {
      // Back-compat: no profile pin → any of the three sources works.
      hasAuth = Boolean(apiKey) || subscriptionActive;
      if (apiKey) {
        authDetail = `${CODEX_API_KEY_ENV} set (API-key auth; no profile pin)`;
      } else if (authExists) {
        authDetail = `${authPath} exists (subscription auth, file-backed; no profile pin)`;
      } else if (authProbeOutcome.loggedIn) {
        authDetail = `codex login status reports authenticated (keyring-backed; no profile pin): ${authProbeOutcome.detail}`;
      } else {
        authDetail = `no auth source: ${CODEX_API_KEY_ENV} unset; ${authPath} missing; ${authProbeOutcome.detail}`;
      }
      authRemediation = `run \`codex login\` once on this workstation (subscription auth) or \`export ${CODEX_API_KEY_ENV}=...\` (CI / Doppler), then pin via \`profiles.<name>.auth["${critic.id}"]\` in .agent-review/config.json`;
    }
    checks.push({
      name: "codex_auth_present",
      passed: hasAuth,
      detail: authDetail,
      ...(hasAuth ? {} : { remediation: authRemediation }),
    });

    // SDK package presence — same pattern as gemini-sdk.ts:559-577.
    let sdkLoaded = false;
    try {
      const mod = (await import("@openai/codex-sdk")) as Record<string, unknown>;
      sdkLoaded = typeof mod["Codex"] === "function";
    } catch {
      sdkLoaded = false;
    }
    checks.push({
      name: "codex_sdk_loaded",
      passed: sdkLoaded,
      detail: sdkLoaded
        ? "@openai/codex-sdk imported"
        : "@openai/codex-sdk missing or shape unexpected",
      ...(sdkLoaded
        ? {}
        : { remediation: "make agent-review-deps && make agent-review-build" }),
    });

    // The SDK spawns the `codex` binary as a subprocess. Probe the
    // bundled binary first (resolved via @openai/codex's optional
    // dep), then fall back to PATH `codex` (workstations using
    // `brew install codex` or `npm install -g @openai/codex`). The
    // probe MUST pass for one of the two — without a working binary,
    // every Codex critic invocation fails at first turn (issue #1492).
    let cliCheck: DoctorCheck;
    const probeArgs = ["--version"];
    let probedBinaryPath: string;
    let probedSource: "bundled" | "PATH" | null = null;
    let probeError: Error | null = null;
    let stdout = "";

    if (bundledPath) {
      probedBinaryPath = bundledPath;
      try {
        const result = await execCodex(bundledPath, probeArgs, { timeout: 5_000 });
        stdout = result.stdout;
        probedSource = "bundled";
      } catch (err) {
        probeError = err as Error;
      }
    } else {
      probedBinaryPath = "codex";
    }

    if (probedSource === null) {
      // Either bundled was unresolvable, or it was resolvable but the
      // probe failed. Fall back to PATH `codex` so the doctor accounts
      // for workstations that don't have a bundled binary (npm ci
      // skipped optional deps, platform mismatch, etc.).
      try {
        const result = await execCodex("codex", probeArgs, { timeout: 5_000 });
        stdout = result.stdout;
        probedBinaryPath = "codex";
        probedSource = "PATH";
      } catch (err) {
        // Preserve the first error if PATH probe also fails. This
        // gives operators a more actionable message ("bundled was
        // missing too") than just "spawn codex ENOENT" from PATH.
        if (probeError === null) probeError = err as Error;
      }
    }

    if (probedSource !== null) {
      const sourceLabel =
        probedSource === "bundled"
          ? `bundled @openai/codex binary at ${probedBinaryPath}`
          : `codex on PATH`;
      cliCheck = {
        name: "codex_cli_on_path",
        passed: true,
        detail: `${sourceLabel} reports: ${stdout.trim()}`,
      };
    } else {
      const probeMsg = probeError?.message ?? "unknown error";
      cliCheck = {
        name: "codex_cli_on_path",
        passed: false,
        detail: `codex CLI not resolvable: ${probeMsg} (neither bundled @openai/codex binary nor PATH codex responded to --version)`,
        remediation:
          // Pin the suggested CLI version to the same one @openai/codex-sdk's
          // direct dep declares (currently 0.130.0; check
          // tools/agent-review/node_modules/@openai/codex-sdk/package.json
          // after a bump). Aligns workstation install posture with the
          // version pin in .github/workflows/agent-critic.yml so doctor +
          // CI + runtime CLI semantics stay deterministic.
          "install the Codex CLI pinned to the SDK's resolved version (currently 0.130.0). Recommended for CI: `npm install -g @openai/codex@0.130.0` (also satisfies the SDK's bundled-binary lookup if `npm ci` failed to install the optional platform package). Workstations: `brew install codex` is also supported on macOS but is unpinned — prefer `npm install -g @openai/codex@<lockfile-version>` to match the SDK's bundled-binary semantics. After install, run `codex login` once to seed authentication (keyring or ~/.codex/auth.json depending on cli_auth_credentials_store).",
      };
    }
    checks.push(cliCheck);

    // Sanity: critic.model.id should look like a Codex model id (gpt-*,
    // o*, etc). The Codex SDK doesn't expose a `models.list` surface, so
    // this check stays heuristic. The runtime error from an invalid
    // model id is loud enough that we don't lose visibility — but a
    // doctor-time heuristic catches obvious config typos earlier.
    const familyOk = /^(gpt-|o\d)/i.test(critic.model.id);
    checks.push({
      name: "codex_model_id_family",
      passed: familyOk,
      detail: familyOk
        ? `${critic.model.id} matches gpt-*/o* family pattern`
        : `${critic.model.id} does NOT match expected Codex model family (gpt-* or o*)`,
      ...(familyOk
        ? {}
        : {
            remediation:
              "the configured Codex critic's model.id should look like a Codex model (e.g., 'gpt-5.5-codex'). Update .agent-review/config.json:critics[].model.id.",
          }),
    });

    return checks;
  }
}
