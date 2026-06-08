// df_doctor MCP tool — cycle5 Phase 1 step 2.
//
// Wraps the existing `runDoctor` (`src/doctor.ts`) — the canonical
// env-verification surface used by the `df doctor` subcommand — and
// re-shapes its `DoctorCheck[]` output to the structured contract the
// cycle5 doc defines for the MCP tool:
//
//     { ok: boolean, checks: [{ name, status, message? }] }
//
// Spec-extension decision: the cycle doc leaves `status` open. This
// implementation uses three values:
//   - 'pass' — check succeeded
//   - 'fail' — check failed AND is gating (ok=false)
//   - 'warn' — check failed but is `optional: true` (shadow-mode
//     adapters; ok stays true)
//
// Alternatives considered:
//   - `'pass' | 'fail'` plus a separate `optional?: boolean` field —
//     closer to the source `DoctorCheck` but pushes the optional-vs-
//     required determination onto the client.
//   - `'pass' | 'fail' | 'info'` — 'info' reads weaker than 'warn' for
//     the actually-failing-but-non-gating case ('warn' clearly signals
//     "this check did not pass").
// The chosen three-value enum is documented in the cycle5 step 2 PR
// body. A future cycle can revise via an additive minor bump (add a
// new status value) or a major bump (change semantics).
//
// Side-effect posture: this tool is read-only — it reads files +
// process state and invokes each adapter's `doctor()` method (which
// itself only reads). No file writes, no subprocess execution under
// the developer's identity beyond the existing read-only doctor
// probes.

import { existsSync } from "node:fs";
import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { DoctorCheck } from "@momentiq/dark-factory-schemas";

import { runDoctor } from "../../doctor.js";
import {
  loadDopplerBootstrapEnv,
  DEFAULT_BOOTSTRAP_ALLOWLIST,
} from "../../doppler-bootstrap.js";
import { loadAgentReviewConfig } from "../../policy/config.js";
import { resolveProfile } from "../../policy/profile.js";
import { AdapterRegistry } from "../../adapters/critic.js";

/** Output entry shape — kept exported so other tools / tests can refer. */
export interface DfDoctorCheckEntry {
  readonly name: string;
  readonly status: "pass" | "fail" | "warn";
  readonly message?: string;
}

export interface DfDoctorResult {
  readonly ok: boolean;
  readonly checks: readonly DfDoctorCheckEntry[];
}

/** Pure mapper — unit-tested in tests/mcp/tools/doctor.test.ts. */
export function mapDoctorChecks(input: readonly DoctorCheck[]): DfDoctorResult {
  const checks = input.map((c) => mapOne(c));
  const ok = !checks.some((c) => c.status === "fail");
  return { ok, checks };
}

function mapOne(c: DoctorCheck): DfDoctorCheckEntry {
  if (c.passed) {
    // Strip remediation when the check passed — it should not have been
    // populated in the first place but defends against legacy edge
    // cases (an older check stamping remediation regardless of state).
    return { name: c.name, status: "pass", message: c.detail };
  }
  const status: "fail" | "warn" = c.optional ? "warn" : "fail";
  const message = c.remediation
    ? `${c.detail} — fix: ${c.remediation}`
    : c.detail;
  return { name: c.name, status, message };
}

const RUNDOCTOR_LOADER_CLASSES: ReadonlyArray<{
  readonly id: string;
  readonly modulePath: string;
  readonly className: string;
}> = [
  { id: "cursor-sdk", modulePath: "../../adapters/cursor-sdk.js", className: "CursorSdkAdapter" },
  { id: "codex-sdk", modulePath: "../../adapters/codex-sdk.js", className: "CodexSdkAdapter" },
  { id: "gemini-sdk", modulePath: "../../adapters/gemini-sdk.js", className: "GeminiSdkAdapter" },
  { id: "grok-direct-sdk", modulePath: "../../adapters/grok-direct-sdk.js", className: "GrokDirectSdkAdapter" },
  // Cycle 20 — MiniMax M3 via OpenRouter.
  { id: "minimax-direct-sdk", modulePath: "../../adapters/minimax-direct-sdk.js", className: "MinimaxDirectSdkAdapter" },
  // Consumer DFP #107 — deterministic schema-lint adapter. Must mirror
  // cli.ts ADAPTER_LOADERS so a critic config that names
  // `static-schema-lint` does not emit a false `adapter_..._registered:
  // false` check via the MCP doctor path.
  { id: "static-schema-lint", modulePath: "../../adapters/static-schema-lint.js", className: "StaticSchemaLintAdapter" },
];

async function buildAdapterRegistry(): Promise<AdapterRegistry> {
  // Mirror `src/cli.ts`'s `buildDefaultAdapterRegistry` shape — each
  // adapter module is dynamically imported so a single vendor's
  // static-import failure (e.g. Cursor SDK's transitive `sqlite3`
  // native binding under `npm install --ignore-scripts`) does not
  // abort the MCP tool. Unloadable adapters are skipped silently
  // here because the doctor itself will surface a fail entry via
  // its `adapter_<id>_registered: false` check below.
  const registry = new AdapterRegistry();
  for (const loader of RUNDOCTOR_LOADER_CLASSES) {
    try {
      const mod = (await import(loader.modulePath)) as Record<string, unknown>;
      const Ctor = mod[loader.className] as
        | (new () => import("../../adapters/critic.js").CriticAdapter)
        | undefined;
      if (typeof Ctor === "function") {
        registry.register(new Ctor());
      }
    } catch {
      // adapter unloadable — runDoctor records via adapter_NOT_registered.
    }
  }
  return registry;
}

/** Programmatic entry — used by the tool callback below + tests. */
export async function runDfDoctorTool(
  opts: { cwd?: string; profileName?: string } = {},
): Promise<DfDoctorResult> {
  // Load Doppler bootstrap env (idempotent file read); pass cwd through
  // so the lookup is rooted where the MCP server was launched, not the
  // CLI binary's location.
  loadDopplerBootstrapEnv({
    allowlist: DEFAULT_BOOTSTRAP_ALLOWLIST,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });

  let loaded;
  try {
    loaded = await loadAgentReviewConfig({
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
  } catch (err) {
    // Degenerate path: no `.agent-review/config.json` (or unparseable).
    // Surface as a single fail entry rather than letting the MCP
    // request error out — that way clients still get a structured
    // verdict + a remediation hint they can render.
    return {
      ok: false,
      checks: [
        {
          name: "config_loaded",
          status: "fail",
          message: `failed to load .agent-review/config.json: ${
            (err as Error).message
          } — fix: create .agent-review/config.json at repo root (see README)`,
        },
      ],
    };
  }

  // Belt + suspenders for the existsSync edge case (config loaded but
  // file deleted between loadAgentReviewConfig and now). Cheap; runs
  // once per tool call.
  if (loaded.configPath && !existsSync(loaded.configPath)) {
    return {
      ok: false,
      checks: [
        {
          name: "config_loaded",
          status: "fail",
          message: `.agent-review/config.json disappeared after load (${loaded.configPath})`,
        },
      ],
    };
  }

  const registry = await buildAdapterRegistry();
  const profileName = resolveProfile(
    { profile: opts.profileName },
    process.env as { AGENT_REVIEW_PROFILE?: string | undefined },
  );

  const checks = await runDoctor({
    loaded,
    registry,
    profileName,
  });
  return mapDoctorChecks(checks);
}

function renderMarkdownSummary(result: DfDoctorResult): string {
  const counts = result.checks.reduce(
    (acc, c) => {
      acc[c.status] += 1;
      return acc;
    },
    { pass: 0, fail: 0, warn: 0 },
  );
  const header = `**df_doctor**: ${result.ok ? "OK" : "FAIL"} — pass=${counts.pass}, fail=${counts.fail}, warn=${counts.warn}`;
  const lines = result.checks.map((c) => {
    const marker = c.status === "pass" ? "✓" : c.status === "warn" ? "!" : "✗";
    return `  ${marker} [${c.status}] ${c.name}${c.message ? `: ${c.message}` : ""}`;
  });
  return [header, ...lines].join("\n");
}

export interface RegisterDoctorToolOptions {
  /**
   * Optional cwd override — used by tests to point at a fixture repo
   * root. Production code lets it default to `process.cwd()` so the
   * `.agent-review/config.json` lookup honors wherever the agent
   * client launched `df mcp` from.
   */
  cwd?: string;
}

export function registerDoctorTool(
  server: McpServer,
  opts: RegisterDoctorToolOptions = {},
): void {
  server.registerTool(
    "df_doctor",
    {
      title: "Dark Factory doctor",
      description:
        "Verify the local environment for Dark Factory critic " +
        "invocation: Node version, husky hook wiring, artifact dir " +
        "writability, Doppler bootstrap (if configured), and each " +
        "registered adapter's credential check. Read-only — does not " +
        "modify any state.",
      // Cycle5 spec for df_doctor: input {} (no arguments). Empty
      // ZodRawShape gives a JSON Schema `{ type: 'object', properties: {} }`.
      inputSchema: {},
      outputSchema: {
        ok: z
          .boolean()
          .describe(
            "True if every non-optional check passed. Optional " +
              "(shadow-mode) check failures emit status='warn' but do " +
              "not gate ok.",
          ),
        checks: z
          .array(
            z.object({
              name: z
                .string()
                .describe("Stable id for the check (e.g. 'node_version')."),
              status: z
                .enum(["pass", "fail", "warn"])
                .describe(
                  "'pass' — check OK. 'fail' — check failed and gates " +
                    "ok=false. 'warn' — check failed but is optional " +
                    "(shadow-mode); does not gate ok.",
                ),
              message: z
                .string()
                .optional()
                .describe(
                  "Human-readable detail; for non-pass entries the " +
                    "remediation hint is appended after ' — fix: '.",
                ),
            }),
          )
          .describe(
            "Ordered list of individual check results — same order as " +
              "runDoctor emits them.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        // Hand-rolled "this tool touches the local filesystem only,
        // never the network or other repos". `openWorldHint: false`
        // tells clients we don't reach beyond the developer's repo.
        openWorldHint: false,
      },
    },
    async () => {
      const result = await runDfDoctorTool(
        opts.cwd !== undefined ? { cwd: opts.cwd } : {},
      );
      return {
        // The SDK types `structuredContent` as a generic
        // Record<string, unknown> (it's validated against the
        // registered outputSchema at runtime), so a JSON-shaped
        // cast through `unknown` is the structurally-safe way to
        // pass our typed result through. The schema validator on
        // the SDK side enforces the actual contract.
        structuredContent: result as unknown as Record<string, unknown>,
        // Markdown fallback for clients that don't process structuredContent.
        content: [
          {
            type: "text",
            text: renderMarkdownSummary(result),
          },
        ],
      };
    },
  );
}
