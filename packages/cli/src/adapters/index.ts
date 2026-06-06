// Adapters boundary barrel.
//
// Backs the `./adapters` subpath export declared in package.json:
//   "./adapters": { "import": "./dist/adapters/index.js" }
//
// All four vendor adapter classes and their supporting types flow
// through here so library consumers can do:
//   import { CursorSdkAdapter, GeminiSdkAdapter, ... } from '@momentiq/dark-factory-cli/adapters'
//
// without importing the full package entry point (which pulls in cli.ts
// side effects and heavy optional deps like @cursor/sdk).

export {
  CursorSdkAdapter,
  CURSOR_SDK_ADAPTER_ID,
  CURSOR_API_KEY_ENV,
  buildModelSelection,
  checkRunFinished,
  extractRuntimeModel,
  extractStatusMessage,
  extractRunErrorCode,
  normalizeCriticEcho,
  PERMANENT_ERROR_CODES,
  RETRY_BACKOFF_MS,
  runRetryLoop,
  shouldRetryRunFailure,
  sleepForRetry,
  type AttemptOutcome,
  type RetryableFailure,
} from "./cursor-sdk.js";

export {
  GeminiSdkAdapter,
  GEMINI_SDK_ADAPTER_ID,
  GEMINI_API_KEY_ENV,
  DEFAULT_THINKING_BUDGET,
  GEMINI_PERMANENT_STATUS,
  resolveThinkingBudget,
  extractApiErrorStatus,
  isGeminiPermanentFailure,
  type GeminiClient,
  type GeminiStreamChunk,
  type GeminiSdkAdapterOptions,
} from "./gemini-sdk.js";

export {
  GrokDirectSdkAdapter,
  GROK_DIRECT_SDK_ADAPTER_ID,
  XAI_API_KEY_ENV,
  XAI_BASE_URL,
  GROK_PERMANENT_STATUS,
  DEFAULT_REASONING_EFFORT as GROK_DEFAULT_REASONING_EFFORT,
  resolveReasoningEffort,
  extractXaiApiErrorStatus,
  isGrokPermanentFailure,
  type GrokClient,
  type GrokResponsesCreateParams,
  type GrokStreamEvent,
  type GrokUsage,
  type GrokDirectSdkAdapterOptions,
  type GrokReasoningEffort,
} from "./grok-direct-sdk.js";

// Cycle 20 — MiniMax M3 via Together AI's OpenAI-compatible inference
// endpoint. Mirrors grok-direct-sdk's adapter shape but calls
// `/v1/chat/completions` (OpenAI Chat Completions API) instead of the
// Responses API, because Together exposes Chat Completions — not
// Responses — for MiniMax M3.
export {
  MinimaxDirectSdkAdapter,
  MINIMAX_DIRECT_SDK_ADAPTER_ID,
  TOGETHER_AI_API_KEY_ENV,
  TOGETHER_AI_BASE_URL,
  MINIMAX_PERMANENT_STATUS,
  extractTogetherApiErrorStatus,
  isMinimaxPermanentFailure,
  type MinimaxClient,
  type MinimaxChatCompletionsCreateParams,
  type MinimaxStreamChunk,
  type MinimaxUsage,
  type MinimaxDirectSdkAdapterOptions,
} from "./minimax-direct-sdk.js";

export {
  CodexSdkAdapter,
  CODEX_SDK_ADAPTER_ID,
  CODEX_API_KEY_ENV,
  CODEX_HOME_ENV,
  CODEX_AUTH_CHATGPT,
  CODEX_AUTH_API,
  CODEX_AUTH_MODES,
  DEFAULT_REASONING_EFFORT as CODEX_DEFAULT_REASONING_EFFORT,
  targetTripleForCurrentPlatform,
  resolveBundledCodexCliPath,
  probeCodexLoginStatus,
  resolveCodexReasoningEffort,
  extractCodexErrorCode,
  resolveAuthOrFail,
  type CodexAuthMode,
  type CodexAuthProbeOutcome,
  type CodexExecHook,
  type CodexClient,
  type CodexThread,
  type CodexUsage,
  type CodexTurnResult,
  type CodexThreadOptions,
  type CodexThreadEvent,
  type CodexSdkAdapterOptions,
} from "./codex-sdk.js";

// Issue #28 — Cursor CLI subscription adapter. Routes the local profile
// through the cursor-agent CLI (subscription auth via Keychain) instead
// of @cursor/sdk (which requires CURSOR_API_KEY). Coexists with
// cursor-sdk: cloud/CI profiles continue to use cursor-sdk with the
// Doppler-provisioned key; local profiles use cursor-cli with no key.
export {
  CursorCliAdapter,
  CURSOR_CLI_ADAPTER_ID,
  CURSOR_CLI_BINARY,
  CURSOR_API_KEY_ENV as CURSOR_CLI_API_KEY_ENV_STRIPPED,
  CURSOR_CLI_AUTH_CHATGPT,
  CURSOR_CLI_AUTH_MODES,
  CURSOR_CLI_PERMANENT_SUBTYPES,
  buildCursorCliArgs,
  buildSubscriptionEnv,
  defaultCursorCliRunner,
  extractAssistantText as cursorCliExtractAssistantText,
  extractInitEvent,
  extractResultEnvelope,
  isPermanentResultSubtype,
  resolveAuthOrFail as cursorCliResolveAuthOrFail,
  resolveCursorCliModelId,
  type CursorCliAdapterOptions,
  type CursorCliAuthMode,
  type CursorCliInitEvent,
  type CursorCliResultEnvelope,
  type CursorCliRunArgs,
  type CursorCliRunOutcome,
  type CursorCliRunner,
} from "./cursor-cli.js";

// Consumer dark-factory-platform#107 — deterministic schema-lint adapter.
// Validates JSON-Schema-tagged code blocks in markdown / config-file
// examples (e.g. CLAUDE.md `~/.claude/settings.json` examples). No LLM,
// no network, no auth; runs in <100ms. Closes the local-quorum
// coverage gap where the LLM critics passed a schema-invalid example
// that the cloud-cursor adapter (different prompt envelope) caught.
export {
  StaticSchemaLintAdapter,
  STATIC_SCHEMA_LINT_ADAPTER_ID,
  STATIC_SCHEMAS,
  extractSchemaBlocks,
  stripJsoncSyntax,
  type StaticSchemaLintAdapterOptions,
  type ExtractedBlock,
} from "./static-schema-lint.js";

export {
  AdapterRegistry,
  collectRequiredEnvVars,
  type CriticAdapter,
  type CriticReviewOptions,
} from "./critic.js";
