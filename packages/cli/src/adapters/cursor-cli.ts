// Issue #28 — Cursor CLI subscription adapter.
//
// Why a fifth adapter (manifesto §11 + §12): the `cursor-sdk` adapter
// declares `requiredEnvVars = [CURSOR_API_KEY]` because @cursor/sdk only
// honors API-key auth — `await agent.run(prompt)` throws
// `AuthenticationError(code: "unauthenticated")` when no CURSOR_API_KEY
// is set, even when the workstation has an active Cursor Pro/Pro+/Ultra
// subscription via `cursor-agent login` (the CLI keeps its own session
// state, including macOS Keychain tokens, that the SDK does not read).
//
// This adapter spawns the `cursor-agent` CLI as a subprocess, which uses
// the same Keychain-backed subscription auth as the interactive TUI. The
// cloud profile keeps `cursor-sdk` for CI runs where `CURSOR_API_KEY` is
// provisioned via Doppler; the local profile uses `cursor-cli` so the
// $200 Cursor Pro/Pro+/Ultra subscription absorbs the cost instead of
// burning per-token API-key billing on every commit.
//
// CLI surface (verified against `cursor-agent` 2026.04.17-787b533):
//
//   cursor-agent --print --output-format stream-json --trust \
//                --sandbox enabled --model <id> < <prompt-on-stdin>
//
// Documented in:
//   - cursor.com/docs/cli/reference/parameters — `--trust`:
//     "Trust the workspace without prompting (headless mode only)".
//   - cursor.com/docs/cli/reference/output-format — `--output-format
//     stream-json` emits NDJSON of event types
//     `system | user | assistant | tool_call | tool_result | result |
//     stream_event | error`.
//   - cursor.com/docs/cli/headless — `-p, --print` is the documented
//     non-interactive scripting mode.
//
// Independent best-practice precedent: gsd-build/gsd-2 ADR #6393
// chose this exact factoring for the same reason:
//   "Register cursor-agent via authMode: externalCli ... Spawn
//    cursor-agent -p --output-format stream-json ... Never read/store
//    Cursor OAuth tokens — only check `agent status` or CURSOR_API_KEY
//    env var."
//
// The adapter:
//   - implements `CriticAdapter` with `requiredEnvVars: []`. The CLI's
//     subscription auth is owned by `cursor-agent login` (writes
//     Keychain entries `cursor-access-token` / `cursor-refresh-token`
//     under account `cursor-user`); the adapter does NOT inspect them.
//     Declaring `CURSOR_API_KEY` as required here would force Doppler
//     re-exec on every local invocation even when subscription is the
//     intended path — the exact failure mode the issue #28 reporter
//     hit on alien8d/lyra.
//   - pipes the compiled critic prompt through stdin. Cursor's parser
//     accepts a non-TTY stdin as the prompt source (verified by
//     `printf 'PIPED_OK' | cursor-agent --print --output-format json
//     --trust --model composer-2.5` returning `{"result":"PIPED_OK",
//     ...}` in 8.4s against a fresh /tmp dir, May 2026). This sidesteps
//     the ~256KB argv length cap on macOS that would otherwise truncate
//     review packets containing full changed files (config caps
//     `maxChangedFileBytes: 200000`).
//   - parses NDJSON events:
//       system.init: capture `apiKeySource` ("env" | "flag" | "login").
//         When `auth: "chatgpt"` is pinned, MUST be "login" — anything
//         else proves a stray CURSOR_API_KEY leaked into the subprocess
//         env and the run gets billed against the subscription's
//         API-key budget instead of session-token subscription. Fail
//         closed in that case (defense-in-depth above the env strip).
//       assistant.message.content[].text: accumulate as `assistantText`
//         — same shape as cursor-sdk.ts uses for the SDK stream.
//       result: terminal envelope with `is_error`, `subtype`,
//         `duration_ms`, `usage`, and the assembled `result` text. The
//         adapter parses `result` as JSON (defense in depth) AND uses
//         the accumulated `assistantText` as a fallback if `result` is
//         empty.
//   - reuses unchanged: `compileCriticPrompt`, `parseAssistantJson`,
//     `normalizeCriticEcho`, `mergeAdapterMetadata`, `parseCriticResult`,
//     `buildErrorResult`, `writeRedactedDiagnostic`, `runRetryLoop`.
//   - strips `CURSOR_API_KEY` from the subprocess env when
//     auth="chatgpt". Belt-and-suspenders against a Doppler-leaked env
//     var routing the run through API-key billing without the operator
//     noticing.
//   - is read-only by structure at two layers:
//       1. `--sandbox enabled` — the CLI's defense-in-depth sandbox
//          blocks file writes even if a malicious diff convinces the
//          model to attempt one.
//       2. The critic prompt's `treatDiffAsUntrusted: true` setting
//          tags diff content as untrusted input (handled by
//          `compileCriticPrompt`).
//     Network access is not separately togglable through the CLI flags
//     (the SDK exposes `networkAccessEnabled` per-thread; the CLI does
//     not). Defense in depth comes from the sandbox + the prompt
//     `treatDiffAsUntrusted` + the subscription session being
//     constrained to Cursor's own model proxy. Document the gap rather
//     than fake equivalence.
//
// Like `codex-sdk.ts`, uses a `runCursorAgentCli` factory option for test
// injection so tests don't spawn the real CLI. The `defaultCursorAgentCli`
// factory below is exported solely so the doctor can use it for the
// `cursor_cli_version` probe without re-implementing the spawn.
//
// Testing posture: every subprocess interaction is mockable through one of
// `runCursorAgentCli` (the review-path spawn) or `execCursorAgent` (the
// doctor's `--version` / `status` / `ls-models` probes). Tests construct a
// CursorCliAdapter with both factories swapped for scripted outcomes,
// matching the test surface of codex-sdk.ts's `createCodex` factory.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { compileCriticPrompt } from "../prompt.js";
import {
  parseCriticResult,
  type CriticConfig,
  type CriticResult,
  type DoctorCheck,
  type ReviewPacket,
} from "@momentiq/dark-factory-schemas";

import type { CriticAdapter, CriticReviewOptions } from "./critic.js";
import {
  buildErrorResult,
  mergeAdapterMetadata,
  normalizeCriticEcho,
  parseAssistantJson,
  writeRedactedDiagnostic,
} from "./_shared.js";
import {
  runRetryLoop,
  type AttemptOutcome,
} from "./_retry.js";

const execFileAsync = promisify(execFile);

export const CURSOR_CLI_ADAPTER_ID = "cursor-cli";
export const CURSOR_CLI_BINARY = "cursor-agent";
// Stripped from subprocess env when auth="chatgpt" so subscription auth
// can't be silently overridden by a stray Doppler-leaked key.
export const CURSOR_API_KEY_ENV = "CURSOR_API_KEY";

// Issue #28 — this adapter is subscription-only. The CLI itself supports
// `--api-key` / `CURSOR_API_KEY` (verified in `cursor-agent --help`), but
// routing API-key auth through the CLI is strictly worse than the SDK
// (extra fork + spawn + stream-parse for no benefit). Profiles needing
// API-key auth route to `cursor-sdk`; profiles needing subscription
// route to `cursor-cli`.
export const CURSOR_CLI_AUTH_CHATGPT = "chatgpt" as const;
export type CursorCliAuthMode = typeof CURSOR_CLI_AUTH_CHATGPT;
export const CURSOR_CLI_AUTH_MODES: readonly CursorCliAuthMode[] = [
  CURSOR_CLI_AUTH_CHATGPT,
];

// Cursor exposes "<model>-fast" model IDs alongside the non-fast
// variants (e.g. `composer-2.5` vs `composer-2.5-fast`). The config
// schema lets a critic declare a `fast: true|false` param; the adapter
// here resolves the effective `--model` CLI arg. When `fast=true`, the
// suffix is appended if not already present. When `fast=false` (the
// default for chief-engineer-grade reviews), the bare model id is used.
const FAST_PARAM_ID = "fast";

/**
 * Resolve the effective `--model` arg from a critic config. Appends the
 * `-fast` suffix when the critic declares `fast: true` (and the id
 * doesn't already carry the suffix). Exported for direct unit testing.
 */
export function resolveCursorCliModelId(critic: CriticConfig): string {
  const fast = critic.model.params.find((p) => p.id === FAST_PARAM_ID);
  const id = critic.model.id;
  const fastValue = fast ? String(fast.value).toLowerCase() : "false";
  if (fastValue === "true") {
    return id.endsWith("-fast") ? id : `${id}-fast`;
  }
  return id;
}

// ---------------------------------------------------------------------------
// stream-json event extractors. Each is pure and unit-testable in
// isolation. Shapes verified against cursor-agent 2026.04.17-787b533
// empirical capture + the documented schema at
// cursor.com/docs/cli/reference/output-format.

/**
 * `system.init` event — emitted as the first event in `--output-format
 * stream-json` mode. Documented fields: `type`, `subtype`,
 * `apiKeySource`, `cwd`, `session_id`, `model`, `permissionMode`.
 *
 * `apiKeySource` is the trust signal: `"login"` means the CLI used
 * Keychain-backed subscription auth (the desired mode for `cursor-cli`),
 * `"env"` means a `CURSOR_API_KEY` env var was honored, `"flag"` means
 * `--api-key` was passed. When auth is pinned to "chatgpt", anything
 * other than "login" fails the run closed (issue #28 defense in depth).
 */
export interface CursorCliInitEvent {
  apiKeySource?: string;
  sessionId?: string;
  model?: string;
  permissionMode?: string;
  cwd?: string;
}

export function extractInitEvent(event: unknown): CursorCliInitEvent | null {
  if (typeof event !== "object" || event === null) return null;
  const e = event as Record<string, unknown>;
  if (e["type"] !== "system" || e["subtype"] !== "init") return null;
  const out: CursorCliInitEvent = {};
  if (typeof e["apiKeySource"] === "string") out.apiKeySource = e["apiKeySource"];
  if (typeof e["session_id"] === "string") out.sessionId = e["session_id"];
  if (typeof e["model"] === "string") out.model = e["model"];
  if (typeof e["permissionMode"] === "string") out.permissionMode = e["permissionMode"];
  if (typeof e["cwd"] === "string") out.cwd = e["cwd"];
  return out;
}

/**
 * `assistant` event — `message.content[]` array with `type: "text"`
 * entries the model wrote. Same shape as the @cursor/sdk stream (verified
 * empirically) so this extractor mirrors `cursor-sdk.ts:extractAssistantText`.
 *
 * Returns the empty string for non-assistant events or malformed shapes.
 */
export function extractAssistantText(event: unknown): string {
  if (typeof event !== "object" || event === null) return "";
  const e = event as Record<string, unknown>;
  if (e["type"] !== "assistant") return "";
  const message = e["message"];
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>)["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (!c || typeof c !== "object") return "";
      const block = c as Record<string, unknown>;
      if (block["type"] !== "text") return "";
      const t = block["text"];
      return typeof t === "string" ? t : "";
    })
    .join("");
}

/**
 * `result` event — terminal envelope. Documented fields: `type`,
 * `subtype`, `duration_ms`, `duration_api_ms`, `is_error`, `result`,
 * `session_id`, `request_id`, `usage`. Stream parsing stops once this
 * event is observed (or the subprocess exits, whichever comes first).
 */
export interface CursorCliResultEnvelope {
  isError: boolean;
  subtype: string | null;
  resultText: string;
  sessionId: string | null;
  requestId: string | null;
  durationMs: number | null;
  usageInputTokens: number | null;
  usageOutputTokens: number | null;
}

export function extractResultEnvelope(event: unknown): CursorCliResultEnvelope | null {
  if (typeof event !== "object" || event === null) return null;
  const e = event as Record<string, unknown>;
  if (e["type"] !== "result") return null;
  const usage = e["usage"];
  const u = (typeof usage === "object" && usage !== null
    ? (usage as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  return {
    isError: typeof e["is_error"] === "boolean" ? (e["is_error"] as boolean) : false,
    subtype: typeof e["subtype"] === "string" ? (e["subtype"] as string) : null,
    resultText: typeof e["result"] === "string" ? (e["result"] as string) : "",
    sessionId: typeof e["session_id"] === "string" ? (e["session_id"] as string) : null,
    requestId: typeof e["request_id"] === "string" ? (e["request_id"] as string) : null,
    durationMs: typeof e["duration_ms"] === "number" ? (e["duration_ms"] as number) : null,
    usageInputTokens: typeof u["inputTokens"] === "number" ? (u["inputTokens"] as number) : null,
    usageOutputTokens:
      typeof u["outputTokens"] === "number" ? (u["outputTokens"] as number) : null,
  };
}

// Permanent error subtypes — when `result.is_error === true`, this set
// determines whether the failure is permanent (retrying wastes budget
// AND can mask the real fault) or retryable (transient upstream blip).
//
// PENDING EMPIRICAL OBSERVATION: the canonical cursor-agent error
// subtype vocabulary is not publicly documented as of CLI 2026.04.17.
// The set below is seeded from PERMANENT_ERROR_CODES in `_retry.ts`
// (the SDK adapters' shape) plus Cursor-specific subtypes seen in
// community scripts; it will need tuning from real-world telemetry
// once production traffic exposes the actual surface. Unknown
// subtypes default to retryable (the conservative bias — permanent
// classification on an unknown surface would silently swallow genuine
// transient outages).
export const CURSOR_CLI_PERMANENT_SUBTYPES: ReadonlySet<string> = new Set([
  "error_auth_failed",
  "error_invalid_api_key",
  "error_quota_exceeded",
  "error_invalid_request",
  "error_context_length_exceeded",
  "error_content_policy_violation",
  "error_model_not_found",
  // Cursor-specific subtypes also observed in scripts/tarq.net coverage:
  "error_subscription_required",
  "error_workspace_not_trusted",
]);

/**
 * Classify a `result` envelope's `subtype` as permanent vs retryable.
 * Returns `true` for the permanent set, `false` otherwise (unknown
 * subtypes are treated as retryable). Exported for unit testing.
 */
export function isPermanentResultSubtype(subtype: string | null): boolean {
  if (subtype === null) return false;
  return CURSOR_CLI_PERMANENT_SUBTYPES.has(subtype);
}

// ---------------------------------------------------------------------------
// Subprocess runner — the test seam.

/**
 * Aggregate outcome of a single subprocess invocation. The adapter
 * dispatches on these fields; tests inject a stub returning a scripted
 * shape so no real `cursor-agent` process is spawned during unit tests.
 */
export interface CursorCliRunOutcome {
  /** Parsed NDJSON events from stdout, in order. */
  events: unknown[];
  /** Process exit code (`null` if the process was killed by a signal). */
  exitCode: number | null;
  /** Captured stderr (typically empty on success; carries CLI errors). */
  stderr: string;
  /**
   * Set when the subprocess could not be spawned at all (e.g., the
   * `cursor-agent` binary was not on PATH). The adapter treats this as a
   * permanent install failure rather than a retryable run failure.
   */
  spawnError: Error | null;
}

export interface CursorCliRunArgs {
  binaryPath: string;
  cliArgs: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  prompt: string;
  signal?: AbortSignal;
}

export type CursorCliRunner = (args: CursorCliRunArgs) => Promise<CursorCliRunOutcome>;

/**
 * Default production runner. Spawns the CLI, writes the compiled
 * prompt to stdin, parses NDJSON line-by-line from stdout, captures
 * stderr verbatim, resolves once the subprocess exits (or once the
 * AbortSignal fires, in which case the subprocess is killed first).
 *
 * Returns a `spawnError` when spawning itself failed (ENOENT, EACCES,
 * etc.) so the adapter can surface a clear install/binary failure
 * instead of a generic transport error.
 */
export const defaultCursorCliRunner: CursorCliRunner = async (args) => {
  const events: unknown[] = [];
  let stderr = "";
  let spawnError: Error | null = null;

  let child;
  try {
    child = spawn(args.binaryPath, args.cliArgs as string[], {
      cwd: args.cwd,
      env: args.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    return {
      events,
      exitCode: null,
      stderr,
      spawnError: err as Error,
    };
  }

  // The child can emit an 'error' event AFTER successful spawn() return
  // (e.g., ENOENT surfaces here on some platforms instead of synchronous
  // throw). Capture as spawnError so the adapter classifies it as a
  // permanent install failure.
  child.on("error", (err) => {
    spawnError = err;
  });

  // Pipe the prompt in. The CLI documents stdin as a supported prompt
  // source in print mode; failure to write here is treated as a
  // subprocess startup failure (most commonly a broken pipe if the CLI
  // exits early because of a missing binary or invalid argument).
  if (child.stdin) {
    try {
      child.stdin.end(args.prompt, "utf8");
    } catch (err) {
      spawnError = err as Error;
    }
  }

  // Read stderr opportunistically; the CLI sometimes prints argv parse
  // errors here before exiting.
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
  }

  // Parse stdout as NDJSON; each line is a single JSON event. The
  // line buffer accumulates partial lines until a `\n` arrives. Once
  // the subprocess closes stdout, flush any trailing buffered line.
  let lineBuf = "";
  if (child.stdout) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      lineBuf += chunk;
      let nl: number;
      while ((nl = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          // Malformed NDJSON line — skip rather than crash. The CLI
          // shouldn't emit these in practice; defense in depth.
        }
      }
    });
  }

  // Honor AbortSignal — kill the subprocess if the caller aborts.
  // SIGTERM gives the CLI a chance to clean up its own pty/session
  // state (a clean shutdown emits a partial result envelope we still
  // want); SIGKILL after a 5s grace period guarantees the runner
  // returns even if the CLI ignores SIGTERM. Without the escalation
  // path, an unresponsive cursor-agent could hang the review forever
  // despite the caller having aborted. (Copilot review feedback,
  // dark-factory PR #52.)
  let abortHandler: (() => void) | null = null;
  let killEscalationTimer: ReturnType<typeof setTimeout> | null = null;
  const KILL_ESCALATION_GRACE_MS = 5_000;
  if (args.signal) {
    abortHandler = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Best effort.
      }
      killEscalationTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best effort.
        }
      }, KILL_ESCALATION_GRACE_MS);
    };
    args.signal.addEventListener("abort", abortHandler);
  }

  // Resolve on 'close', not 'exit'. The 'exit' event fires when the
  // child terminates, but stdout/stderr streams may still have
  // buffered data being delivered to our 'data' handlers — so flushing
  // lineBuf on 'exit' can miss the trailing NDJSON line (often the
  // terminal result event), causing a spurious no_terminal_result
  // failure. The 'close' event waits for ALL stdio streams to drain
  // before firing, so by the time we get here we've received every
  // byte the CLI ever wrote. (Copilot review feedback, dark-factory
  // PR #52.)
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", (code, _sig) => {
      resolve(code);
    });
  });

  if (killEscalationTimer) {
    clearTimeout(killEscalationTimer);
  }
  if (args.signal && abortHandler) {
    args.signal.removeEventListener("abort", abortHandler);
  }

  // Flush any trailing buffered line.
  if (lineBuf.trim()) {
    try {
      events.push(JSON.parse(lineBuf.trim()));
    } catch {
      // Defense in depth — trailing junk is not actionable.
    }
  }

  return {
    events,
    exitCode,
    stderr,
    spawnError,
  };
};

// ---------------------------------------------------------------------------
// Auth resolution. Same shape as codex-sdk.ts:resolveAuthOrFail but
// narrower (this adapter only supports "chatgpt"); rejects any other
// pinned value with a clear redirect to `cursor-sdk`.

/**
 * Issue #28 — strict-no-fallback auth resolution. Validates `critic.auth`
 * against the cursor-cli adapter vocabulary
 * ({@link CURSOR_CLI_AUTH_MODES}) and surfaces every misuse as
 * `permanent_failure` so the outer retry loop returns the configuration
 * error immediately (retrying a config mistake just wastes budget).
 *
 * Two failure shapes, both permanent (no retry):
 *
 *   1. `critic.auth === undefined`: profile didn't pin auth. Surfaces
 *      as `permanent_failure` with a message naming the critic + the
 *      exact config path the operator must edit.
 *
 *   2. `critic.auth` is set but not "chatgpt" (e.g., "api"): this
 *      adapter is subscription-only. Error message directs the
 *      operator to use the `cursor-sdk` adapter instead (which is
 *      designed for API-key auth) — fixing the config rather than
 *      muddling adapter responsibilities.
 */
export function resolveAuthOrFail(
  critic: CriticConfig,
  attemptIdx: number,
): { kind: "ok"; mode: CursorCliAuthMode } | Extract<AttemptOutcome, { kind: "permanent_failure" }> {
  const authRaw = critic.auth;
  if (authRaw === undefined) {
    return {
      kind: "permanent_failure",
      errorCode: null,
      statusMessage: null,
      result: buildErrorResult({
        critic,
        message:
          `cursor-cli critic "${critic.id}" has no auth source pinned. ` +
          `Add \`profiles.<name>.auth["${critic.id}"]\` = "${CURSOR_CLI_AUTH_CHATGPT}" to .agent-review/config.json. ` +
          `(Issue #28 — env-presence inference was never available for this adapter ` +
          `because the cursor-agent CLI's subscription session is owned by Keychain, not env vars.)`,
        retryable: false,
        retryCount: attemptIdx,
      }),
    };
  }
  if (authRaw !== CURSOR_CLI_AUTH_CHATGPT) {
    return {
      kind: "permanent_failure",
      errorCode: null,
      statusMessage: null,
      result: buildErrorResult({
        critic,
        message:
          `cursor-cli critic "${critic.id}" has auth="${authRaw}" but this adapter only supports ` +
          `auth="${CURSOR_CLI_AUTH_CHATGPT}" (subscription via \`cursor-agent login\`). ` +
          `For API-key auth, route the critic through the cursor-sdk adapter instead.`,
        retryable: false,
        retryCount: attemptIdx,
      }),
    };
  }
  return { kind: "ok", mode: CURSOR_CLI_AUTH_CHATGPT };
}

// ---------------------------------------------------------------------------
// Subprocess invocation helpers.

/**
 * Build the CLI argv array for a review run. Pure function — no env
 * inspection — so the test surface is a flat array. Order is documented
 * by Cursor; the adapter sets every flag explicitly rather than relying
 * on defaults so behavior is reproducible across CLI versions.
 *
 *   --print                           Headless mode (no TUI).
 *   --output-format stream-json       NDJSON events on stdout.
 *   --trust                           Workspace trust without prompting
 *                                     (only valid with --print).
 *   --sandbox enabled                 Read-only sandbox; blocks file
 *                                     writes even if the model attempts
 *                                     one (defense in depth against
 *                                     untrusted diff content).
 *   --model <id>                      Resolved by resolveCursorCliModelId.
 *
 * The prompt itself is NOT an argv member — it's piped via stdin to
 * sidestep the macOS argv length cap (~256KB) that would truncate
 * review packets with full changed files (config caps
 * `maxChangedFileBytes: 200000`).
 */
export function buildCursorCliArgs(modelId: string): string[] {
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--trust",
    "--sandbox",
    "enabled",
    "--model",
    modelId,
  ];
}

/**
 * Strip `CURSOR_API_KEY` from the subprocess env when auth is pinned to
 * "chatgpt". Belt-and-suspenders against a Doppler-leaked env var
 * routing the run through API-key billing without the operator
 * noticing. The `system.init.apiKeySource` assertion below is the
 * second layer — if a key somehow leaks past this strip, the run still
 * fails closed because `apiKeySource !== "login"`.
 */
export function buildSubscriptionEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env[CURSOR_API_KEY_ENV];
  return env;
}

// ---------------------------------------------------------------------------
// Constructor options.

export interface CursorCliAdapterOptions {
  /**
   * Override the cursor-agent binary path. Default: the literal
   * "cursor-agent" (resolved via PATH at spawn time). Tests pass a
   * fixed string to assert which path was probed.
   */
  binaryPath?: string;
  /**
   * Test escape hatch — inject a scripted subprocess runner. Production
   * uses {@link defaultCursorCliRunner} which actually spawns the CLI.
   */
  runCursorAgentCli?: CursorCliRunner;
  /**
   * Test escape hatch for the `execFile` doctor-probe wrapper. Production
   * uses the promisified `child_process.execFile`. Tests pass a mock to
   * avoid spawning the real binary and to assert which arguments the
   * doctor probed.
   */
  execCursorAgent?: (
    binaryPath: string,
    args: readonly string[],
    options?: { timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  /**
   * Test escape hatch for the retry-loop sleep. When unset the adapter
   * uses the real `sleepForRetry` (wall-clock + AbortSignal-aware).
   * Mirrors the same hook on `runRetryLoop` so tests don't have to
   * wait for 5s + 15s of real backoff to exercise retry behavior.
   */
  sleep?: (idx: number, signal: AbortSignal | undefined) => Promise<void>;
  /**
   * Override the `process.env` snapshot used as the base for the
   * subprocess env. Tests pass a fixed map so the env-strip behavior
   * is hermetic.
   */
  baseEnv?: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// The adapter.

export class CursorCliAdapter implements CriticAdapter {
  readonly id = CURSOR_CLI_ADAPTER_ID;
  // Issue #28 — empty because the CLI's subscription session is owned
  // by Keychain (managed by `cursor-agent login`), not by env vars. The
  // doctor check validates that subscription auth is configured via
  // `cursor-agent status`; CURSOR_API_KEY is never inspected by this
  // adapter (and is actively stripped from the subprocess env).
  readonly requiredEnvVars: readonly string[] = [];

  private readonly run: CursorCliRunner;
  private readonly exec: (
    binaryPath: string,
    args: readonly string[],
    options?: { timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }>;

  constructor(private readonly options: CursorCliAdapterOptions = {}) {
    this.run = options.runCursorAgentCli ?? defaultCursorCliRunner;
    this.exec =
      options.execCursorAgent ??
      ((binaryPath: string, args: readonly string[], opts?: { timeout?: number }) =>
        execFileAsync(binaryPath, args as string[], opts ?? {}));
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
            ? `cursor-cli run aborted after ${retriesUsed} retries: ${last.message}`
            : "cursor-cli run aborted before any attempt completed"
          : last
            ? `cursor-cli run failed after ${retriesUsed} retries: ${last.message}`
            : "cursor-cli run failed with no captured failure metadata";
        return buildErrorResult({
          critic,
          message: summary,
          retryable: true,
          ...(last?.errorCode != null ? { code: last.errorCode } : {}),
          retryCount: retriesUsed,
          ...(last?.runId !== null && last?.runId !== undefined ? { runId: last.runId } : {}),
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
    // Strict auth pin.
    const authResolved = resolveAuthOrFail(critic, attemptIdx);
    if (authResolved.kind === "permanent_failure") return authResolved;

    const modelId = resolveCursorCliModelId(critic);
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

    const binaryPath = this.options.binaryPath ?? CURSOR_CLI_BINARY;
    const env = buildSubscriptionEnv(this.options.baseEnv ?? process.env);
    const cliArgs = buildCursorCliArgs(modelId);

    let outcome: CursorCliRunOutcome;
    try {
      outcome = await this.run({
        binaryPath,
        cliArgs,
        env,
        cwd: packet.repoRoot,
        prompt: prompt.text,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
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
        message: `cursor-cli runner threw: ${e.message}`,
        runId: null,
        agentId: null,
      };
    }

    // 1. Spawn failure — classify by error code. The runner sets
    //    `spawnError` in three places:
    //      (a) synchronous `spawn()` throw,
    //      (b) async 'error' event after spawn returned (often ENOENT
    //          on some platforms),
    //      (c) stdin write failure (e.g. EPIPE because the CLI exited
    //          early on a bad argument).
    //
    //    Only ENOENT (binary not on PATH) and EACCES (binary not
    //    executable) are unambiguous install/permission problems
    //    warranting the "install + login" remediation. Other errors —
    //    notably EPIPE from (c) — can coexist with the CLI having
    //    already written a useful error to stderr before exiting, so
    //    we fall through to the no_terminal_result path below, which
    //    surfaces exitCode + stderr instead of the misleading
    //    install message. (Copilot review feedback, dark-factory
    //    PR #52.)
    if (outcome.spawnError) {
      const errCode = (outcome.spawnError as NodeJS.ErrnoException).code;
      const isInstallProblem = errCode === "ENOENT" || errCode === "EACCES";
      if (isInstallProblem) {
        options.emit?.({
          ts: new Date().toISOString(),
          event: "critic_run_error",
          commit: packet.commit.sha,
          criticId: critic.id,
          adapter: this.id,
          model: critic.model.id,
          durationMs: Date.now() - startMs,
          error: outcome.spawnError.message,
          status: "startup_failure",
          retryCount: attemptIdx,
        });
        return {
          kind: "permanent_failure",
          errorCode: null,
          statusMessage: null,
          result: buildErrorResult({
            critic,
            message:
              `cursor-cli failed to spawn ${binaryPath} (${errCode}): ${outcome.spawnError.message}. ` +
              `Install the Cursor CLI (\`curl https://cursor.com/install -fsS | bash\`) and run \`cursor-agent login\`.`,
            retryable: false,
            retryCount: attemptIdx,
          }),
        };
      }
      // Non-install spawnError (EPIPE, etc.) — log it but fall through
      // so the no_terminal_result path below can surface the CLI's
      // own stderr message (which is usually the more actionable
      // signal — "Error: invalid argument" tells the operator more
      // than "EPIPE writing to subprocess").
      options.emit?.({
        ts: new Date().toISOString(),
        event: "critic_run_error",
        commit: packet.commit.sha,
        criticId: critic.id,
        adapter: this.id,
        model: critic.model.id,
        durationMs: Date.now() - startMs,
        error: `spawnError ${errCode ?? "?"}: ${outcome.spawnError.message}`,
        status: "spawn_warning",
        retryCount: attemptIdx,
      });
    }

    // 2. Parse the event stream.
    let initEvent: CursorCliInitEvent | null = null;
    let resultEvent: CursorCliResultEnvelope | null = null;
    let assistantText = "";
    let sessionId: string | null = null;

    for (const event of outcome.events) {
      const init = extractInitEvent(event);
      if (init) {
        initEvent = init;
        if (init.sessionId) sessionId = init.sessionId;
        continue;
      }
      const text = extractAssistantText(event);
      if (text) assistantText += text;
      const result = extractResultEnvelope(event);
      if (result) {
        resultEvent = result;
        if (result.sessionId && !sessionId) sessionId = result.sessionId;
      }
    }

    // 3. Defense-in-depth check: apiKeySource MUST be "login" when
    //    auth is pinned to "chatgpt". Anything else proves a stray
    //    CURSOR_API_KEY or --api-key leaked into the subprocess despite
    //    the env strip — fail closed rather than silently bill against
    //    API-key budget.
    //
    // Permissive on `apiKeySource === undefined`: if a future CLI
    // version drops or renames the field, this defense silently
    // degrades, but the env strip (buildSubscriptionEnv) is the
    // primary gate — defense in depth, not defense alone.
    if (
      initEvent &&
      initEvent.apiKeySource !== undefined &&
      initEvent.apiKeySource !== "login"
    ) {
      const diagPath = writeRedactedDiagnostic({
        diagnosticsDir: options.diagnosticsDir,
        criticId: critic.id,
        commit: packet.commit.sha,
        rawText: `system.init.apiKeySource=${initEvent.apiKeySource}\n${assistantText}`,
      });
      options.emit?.({
        ts: new Date().toISOString(),
        event: "critic_run_error",
        commit: packet.commit.sha,
        criticId: critic.id,
        adapter: this.id,
        model: critic.model.id,
        durationMs: Date.now() - startMs,
        error: `apiKeySource=${initEvent.apiKeySource} (expected "login")`,
        status: "auth_routing_failure",
        retryCount: attemptIdx,
        ...(sessionId !== null ? { runId: sessionId } : {}),
      });
      return {
        kind: "permanent_failure",
        errorCode: "auth_routing_failure",
        statusMessage: null,
        result: buildErrorResult({
          critic,
          message:
            `cursor-cli expected subscription auth (apiKeySource="login") but the CLI reported ` +
            `apiKeySource="${initEvent.apiKeySource}". A CURSOR_API_KEY env var or --api-key flag ` +
            `routed the run through API-key billing despite the subscription pin. ` +
            `Check Doppler / shell env for a leaked CURSOR_API_KEY.`,
          retryable: false,
          code: "auth_routing_failure",
          ...(diagPath !== undefined ? { rawSamplePath: diagPath } : {}),
          ...(sessionId !== null ? { runId: sessionId } : {}),
          retryCount: attemptIdx,
        }),
      };
    }

    // 4. No result envelope at all → invocation failed before producing
    //    structured output. Surface the captured stderr so the operator
    //    sees the CLI's own error message ("Error: No prompt provided",
    //    "Cannot use this model: X", etc.). Permanent — these errors do
    //    not improve with retry.
    if (!resultEvent) {
      const stderrSnip = outcome.stderr.trim().slice(0, 500);
      const exitMsg = `exit=${outcome.exitCode ?? "null"}`;
      const diagPath = writeRedactedDiagnostic({
        diagnosticsDir: options.diagnosticsDir,
        criticId: critic.id,
        commit: packet.commit.sha,
        rawText: `stderr=${outcome.stderr}\nassistantText=${assistantText}`,
      });
      options.emit?.({
        ts: new Date().toISOString(),
        event: "critic_run_error",
        commit: packet.commit.sha,
        criticId: critic.id,
        adapter: this.id,
        model: critic.model.id,
        durationMs: Date.now() - startMs,
        error: `no result envelope (${exitMsg}): ${stderrSnip}`,
        status: "no_terminal_result",
        retryCount: attemptIdx,
      });
      return {
        kind: "permanent_failure",
        errorCode: "no_terminal_result",
        statusMessage: null,
        result: buildErrorResult({
          critic,
          message:
            `cursor-cli emitted no terminal result event (${exitMsg}). ` +
            `stderr: ${stderrSnip || "(empty)"}`,
          retryable: false,
          code: "no_terminal_result",
          ...(diagPath !== undefined ? { rawSamplePath: diagPath } : {}),
          retryCount: attemptIdx,
        }),
      };
    }

    // 5. Result with is_error=true → classify by subtype.
    if (resultEvent.isError) {
      const subtype = resultEvent.subtype;
      const permanent = isPermanentResultSubtype(subtype);
      options.emit?.({
        ts: new Date().toISOString(),
        event: "critic_run_error",
        commit: packet.commit.sha,
        criticId: critic.id,
        adapter: this.id,
        model: critic.model.id,
        durationMs: Date.now() - startMs,
        error: `result is_error=true subtype=${subtype ?? "(unset)"}`,
        status: permanent ? "run_failure_permanent" : "run_failure",
        retryCount: attemptIdx,
        ...(subtype !== null ? { errorCode: subtype } : {}),
        ...(sessionId !== null ? { runId: sessionId } : {}),
      });
      if (permanent) {
        return {
          kind: "permanent_failure",
          errorCode: subtype,
          statusMessage: null,
          result: buildErrorResult({
            critic,
            message: `cursor-cli run failed (permanent, subtype=${subtype ?? "unknown"})`,
            retryable: false,
            ...(subtype !== null ? { code: subtype } : {}),
            ...(sessionId !== null ? { runId: sessionId } : {}),
            retryCount: attemptIdx,
          }),
        };
      }
      return {
        kind: "retryable_failure",
        errorCode: subtype,
        statusMessage: null,
        message: `cursor-cli run failed (retryable, subtype=${subtype ?? "unknown"})`,
        runId: sessionId,
        agentId: null,
      };
    }

    // 6. Happy path — parse the JSON body of the result. The CLI's
    //    `result` envelope carries the assembled assistant text in its
    //    `.result` field (verified empirically — matches the
    //    `--output-format json` single-envelope shape). Fall back to
    //    the accumulated `assistantText` if `result` is empty (defense
    //    in depth against shape drift).
    const candidateText =
      resultEvent.resultText && resultEvent.resultText.length > 0
        ? resultEvent.resultText
        : assistantText;
    const parseOutcome = parseAssistantJson(candidateText);
    if (!parseOutcome.ok) {
      const diagPath = writeRedactedDiagnostic({
        diagnosticsDir: options.diagnosticsDir,
        criticId: critic.id,
        commit: packet.commit.sha,
        rawText: candidateText,
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
        ...(sessionId !== null ? { runId: sessionId } : {}),
      });
      return {
        kind: "permanent_failure",
        errorCode: null,
        statusMessage: null,
        result: buildErrorResult({
          critic,
          message: `cursor-cli critic returned invalid JSON: ${parseOutcome.message}`,
          retryable: false,
          ...(diagPath !== undefined ? { rawSamplePath: diagPath } : {}),
          ...(sessionId !== null ? { runId: sessionId } : {}),
          retryCount: attemptIdx,
        }),
      };
    }

    let result: CriticResult;
    try {
      const normalized = normalizeCriticEcho(parseOutcome.value);
      const enriched = mergeAdapterMetadata(normalized, {
        critic,
        ...(sessionId !== null ? { runId: sessionId } : {}),
      });
      result = parseCriticResult(enriched, options.blockingSeverities);
    } catch (err) {
      const e = err as Error;
      const diagPath = writeRedactedDiagnostic({
        diagnosticsDir: options.diagnosticsDir,
        criticId: critic.id,
        commit: packet.commit.sha,
        rawText: candidateText,
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
        ...(sessionId !== null ? { runId: sessionId } : {}),
      });
      return {
        kind: "permanent_failure",
        errorCode: null,
        statusMessage: null,
        result: buildErrorResult({
          critic,
          message: `cursor-cli critic JSON failed schema validation: ${e.message}`,
          retryable: false,
          ...(diagPath !== undefined ? { rawSamplePath: diagPath } : {}),
          ...(sessionId !== null ? { runId: sessionId } : {}),
          retryCount: attemptIdx,
        }),
      };
    }

    const durationMs = Date.now() - startMs;
    const enriched: CriticResult = {
      ...result,
      durationMs,
      // Cycle 6.3 — surface per-critic telemetry on the artifact-
      // shaped result. The cursor-agent subprocess emits a
      // `result.usage` block (parsed into `resultEvent.usageInput/
      // OutputTokens`); these were previously only included in the
      // adapter's emit-event payload. Hoist onto CriticResult so the
      // hosted runtime persists + prices them. cursor-agent does not
      // report a cached-prefix token count today; tokensCached stays
      // undefined.
      retries: attemptIdx,
      ...(resultEvent.usageInputTokens !== null
        ? { tokensInput: resultEvent.usageInputTokens }
        : {}),
      ...(resultEvent.usageOutputTokens !== null
        ? { tokensOutput: resultEvent.usageOutputTokens }
        : {}),
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
      ...(sessionId !== null ? { runId: sessionId } : {}),
      durationMs,
      ...(enriched.verdict !== undefined ? { verdict: enriched.verdict } : {}),
      findingCount: enriched.findings.length,
      blockerCount,
      highCount,
      ...(resultEvent.usageInputTokens !== null
        ? { tokensIn: resultEvent.usageInputTokens }
        : {}),
      ...(resultEvent.usageOutputTokens !== null
        ? { tokensOut: resultEvent.usageOutputTokens }
        : {}),
      status: "complete",
      retryCount: attemptIdx,
    });

    return { kind: "success", result: enriched };
  }

  async doctor(critic: CriticConfig): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const binaryPath = this.options.binaryPath ?? CURSOR_CLI_BINARY;

    // 1. cursor-agent binary present + version probe.
    let versionStdout = "";
    let versionErr: Error | null = null;
    try {
      const r = await this.exec(binaryPath, ["--version"], { timeout: 5_000 });
      versionStdout = r.stdout;
    } catch (err) {
      versionErr = err as Error;
    }
    if (versionErr) {
      checks.push({
        name: "cursor_cli_on_path",
        passed: false,
        detail: `${binaryPath} --version failed: ${versionErr.message}`,
        remediation:
          "install the Cursor CLI from cursor.com/cli (one-liner: `curl https://cursor.com/install -fsS | bash`), then run `cursor-agent login`",
      });
      return checks;
    }
    checks.push({
      name: "cursor_cli_on_path",
      passed: true,
      detail: `${binaryPath} reports: ${versionStdout.trim()}`,
    });

    // 2. --trust flag available. The flag is documented at
    //    cursor.com/docs/cli/reference/parameters and was present in
    //    every CLI version we tested (2026.04.17+). If it's missing,
    //    every review hangs on the workspace-trust prompt — fail loud.
    let helpStdout = "";
    let helpErr: Error | null = null;
    try {
      const r = await this.exec(binaryPath, ["--help"], { timeout: 5_000 });
      helpStdout = r.stdout;
    } catch (err) {
      helpErr = err as Error;
    }
    const trustSupported = !helpErr && /\s--trust\b/.test(helpStdout);
    checks.push({
      name: "cursor_cli_trust_flag",
      passed: trustSupported,
      detail: trustSupported
        ? "--trust flag is documented by this CLI version"
        : helpErr
          ? `cursor-agent --help failed: ${helpErr.message}`
          : "--trust not found in `cursor-agent --help` output",
      ...(trustSupported
        ? {}
        : {
            remediation:
              "upgrade the Cursor CLI to a version that supports `--trust` (rerun `curl https://cursor.com/install -fsS | bash`)",
          }),
    });

    // 3. cursor-agent status — confirms subscription auth is configured
    //    on this workstation. The CLI exits 0 with "✓ Logged in as <email>"
    //    when subscription auth is available; non-zero otherwise.
    let statusStdout = "";
    let statusErr: Error | null = null;
    try {
      const r = await this.exec(binaryPath, ["status"], { timeout: 5_000 });
      statusStdout = r.stdout;
    } catch (err) {
      statusErr = err as Error;
    }
    const loggedIn = !statusErr && /Logged in/i.test(statusStdout);
    checks.push({
      name: "cursor_cli_subscription_auth",
      passed: loggedIn,
      detail: loggedIn
        ? `cursor-agent status: ${statusStdout.trim()}`
        : statusErr
          ? `cursor-agent status failed: ${statusErr.message}`
          : `cursor-agent status did not report a logged-in session: ${statusStdout.trim() || "(empty)"}`,
      ...(loggedIn
        ? {}
        : {
            remediation:
              "run `cursor-agent login` once on this workstation to authenticate the Cursor Pro/Pro+/Ultra subscription (writes Keychain entries cursor-access-token / cursor-refresh-token under account cursor-user)",
          }),
    });

    // 4. Honor `critic.auth` pin: this adapter must only be used when
    //    the profile pins auth to "chatgpt". A profile that routes
    //    cursor-cli with `auth: "api"` is a config bug — surface it at
    //    doctor time so the operator fixes the profile rather than
    //    discovering the failure at review time.
    if (critic.auth !== undefined && critic.auth !== CURSOR_CLI_AUTH_CHATGPT) {
      checks.push({
        name: "cursor_cli_auth_pin",
        passed: false,
        detail: `critic.auth="${critic.auth}" but cursor-cli only supports "${CURSOR_CLI_AUTH_CHATGPT}"`,
        remediation: `set \`profiles.<name>.auth["${critic.id}"]\` = "${CURSOR_CLI_AUTH_CHATGPT}" in .agent-review/config.json, or move the critic to the cursor-sdk adapter for API-key auth`,
      });
    } else if (critic.auth === undefined) {
      checks.push({
        name: "cursor_cli_auth_pin",
        passed: false,
        detail: `critic.auth is unset; this adapter requires explicit auth="${CURSOR_CLI_AUTH_CHATGPT}" pinning`,
        remediation: `add \`profiles.<name>.auth["${critic.id}"]\` = "${CURSOR_CLI_AUTH_CHATGPT}" in .agent-review/config.json`,
      });
    } else {
      checks.push({
        name: "cursor_cli_auth_pin",
        passed: true,
        detail: `critic.auth="${CURSOR_CLI_AUTH_CHATGPT}" (subscription)`,
      });
    }

    // 5. Resolved --model id is one the CLI exposes. The CLI's argv
    //    parser rejects unknown models with a clear "Cannot use this
    //    model: X. Available models: ..." message, so this doctor check
    //    can probe by invoking with `models` and pattern-matching. The
    //    `models` subcommand was added in newer CLI versions; older
    //    builds support `--list-models`. Try the subcommand first;
    //    fall back to the flag.
    const modelId = resolveCursorCliModelId(critic);
    let modelsStdout = "";
    let modelsErr: Error | null = null;
    try {
      const r = await this.exec(binaryPath, ["models"], { timeout: 5_000 });
      modelsStdout = r.stdout;
    } catch {
      try {
        const r = await this.exec(binaryPath, ["--list-models"], { timeout: 5_000 });
        modelsStdout = r.stdout;
      } catch (err) {
        modelsErr = err as Error;
      }
    }
    if (modelsErr) {
      checks.push({
        name: "cursor_cli_model_available",
        passed: false,
        detail: `could not list cursor models: ${modelsErr.message}`,
        remediation: `verify \`cursor-agent models\` works (requires \`cursor-agent login\`); then confirm "${modelId}" is in the list`,
      });
    } else {
      // Whole-token exact match across both observed output shapes:
      //   - `cursor-agent models` subcommand: one model per line.
      //   - Argv-error path ("Cannot use this model: X. Available
      //     models: ...") and some CLI versions: comma-separated list
      //     on a single line.
      // Splitting on any newline/whitespace/comma/colon and exact-
      // matching the token prevents `composer-2.5` false-positiving
      // against `composer-2.5-fast` (or `gpt-5` against `gpt-5.5`).
      // (Copilot review feedback, dark-factory PR #52.)
      const modelTokens = new Set(
        modelsStdout
          .split(/[\s,:]+/)
          .map((t) => t.trim())
          .filter((t) => t.length > 0),
      );
      const present = modelTokens.has(modelId);
      checks.push({
        name: "cursor_cli_model_available",
        passed: present,
        detail: present
          ? `${modelId} is present in cursor-agent models`
          : `${modelId} not found in cursor-agent models output`,
        ...(present
          ? {}
          : {
              remediation: `update .agent-review/config.json:critics[].model.id to a value present in \`cursor-agent models\` (current resolved id: "${modelId}")`,
            }),
      });
    }

    return checks;
  }
}
