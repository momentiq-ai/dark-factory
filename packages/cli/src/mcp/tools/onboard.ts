// packages/cli/src/mcp/tools/onboard.ts
//
// Cycle 15 Phase C — `df_onboard {target, mode}` MCP tool.
//
// Delegates EVERYTHING beyond analysis-only to `cmdOnboard()` from
// `src/commands/onboard.ts` (Task 4.5) so the MCP path returns the SAME
// merged plan as the CLI path. The MCP tool MUST NOT re-assemble a plan
// from seeders alone — that would skip Phase B's LLM-emitted CLAUDE.md
// and break Task 5 metric 1 through the MCP path.
//
// Per-mode `destructiveHint` annotation is set on the response (NOT on
// the tool registration) because it varies per call:
//   - analysis-only / dry-run → false (read-only / in-memory)
//   - apply / pr             → true  (writes to working tree / opens PR)
//
// Tool-registration `openWorldHint: true` applies to ALL modes —
// analysis reads the filesystem; pr reaches GitHub via gh.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { analyze } from "../../onboard/analyze.js";
import { cmdOnboard, type CmdOnboardPlanResult } from "../../commands/onboard.js";
import type { RepoAnalysis } from "../../onboard/schema.js";
import type { ScaffoldPlan } from "../../onboard/scaffold-schema.js";

export interface RegisterOnboardToolOptions {
  cwd?: string;
}

type OnboardMode = "analysis-only" | "dry-run" | "apply" | "pr";

interface AnalysisOnlyResult {
  analysis: RepoAnalysis;
}

interface PlanResult {
  plan: ScaffoldPlan;
  dryRun: boolean;
  applied: boolean;
  branchName: string | null;
}

function isDestructive(mode: OnboardMode): boolean {
  return mode === "apply" || mode === "pr";
}

function renderMarkdownSummary(input: { mode: OnboardMode; sc: AnalysisOnlyResult | PlanResult }): string {
  if ("analysis" in input.sc) {
    const a = input.sc.analysis;
    return [
      `**df_onboard** (mode=analysis-only)`,
      `- canonicalName: ${a.canonicalName || "(unknown)"}`,
      `- stacks: ${a.stacks.map((s) => s.language).join(", ") || "(none)"}`,
      `- services: ${a.services.length}`,
      `- decisions: ${a.decisions.length}`,
      `- analyzerErrors: ${a.analyzerErrors.length}`,
    ].join("\n");
  }
  const p = input.sc;
  return [
    `**df_onboard** (mode=${input.mode}, dryRun=${p.dryRun}, applied=${p.applied})`,
    `- files in plan: ${p.plan.files.length}`,
    p.branchName ? `- branch: ${p.branchName}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function registerOnboardTool(
  server: McpServer,
  _opts: RegisterOnboardToolOptions = {},
): void {
  server.registerTool(
    "df_onboard",
    {
      title: "Dark Factory onboard",
      description:
        "Run `df onboard` on a target repo. Modes: analysis-only (Phase A — emit RepoAnalysis only), " +
        "dry-run (Phase B+C — emit merged ScaffoldPlan without writing), apply (Phase B+C — write files " +
        "to working tree), pr (Phase B+C — branch + commit + open a PR via gh). 'apply' and 'pr' mutate " +
        "the working tree; their per-call response carries `annotations.destructiveHint: true`.",
      inputSchema: {
        target: z
          .string()
          .describe("Absolute path to the target repo's working tree."),
        mode: z
          .enum(["analysis-only", "dry-run", "apply", "pr"])
          .describe(
            "Operation mode. 'analysis-only' is read-only; 'dry-run' computes a plan but writes nothing; " +
              "'apply' writes files in place; 'pr' writes to a fresh branch and opens a PR.",
          ),
      },
      outputSchema: {
        analysis: z
          .unknown()
          .optional()
          .describe("Present when mode='analysis-only' — the RepoAnalysis JSON."),
        plan: z
          .unknown()
          .optional()
          .describe("Present when mode != 'analysis-only' — the merged ScaffoldPlan."),
        dryRun: z.boolean().optional(),
        applied: z.boolean().optional(),
        branchName: z.string().nullable().optional(),
      },
      annotations: {
        // openWorldHint applies to ALL modes — analysis reads the
        // filesystem; pr reaches GitHub via gh. destructiveHint is NOT
        // set at registration because it varies per-mode (set per-call
        // on the response below).
        openWorldHint: true,
      },
    },
    async (args) => {
      const target = args.target;
      const mode = args.mode as OnboardMode;
      const destructiveHint = isDestructive(mode);

      if (mode === "analysis-only") {
        const analysis = await analyze(target);
        const result: AnalysisOnlyResult = { analysis };
        return {
          structuredContent: result as unknown as Record<string, unknown>,
          content: [{ type: "text", text: renderMarkdownSummary({ mode, sc: result }) }],
          // Per-call destructive flag — analysis-only is read-only.
          annotations: { destructiveHint },
        };
      }

      // dry-run / apply / pr — delegate to cmdOnboard. `json: true` is
      // structurally irrelevant in the orchestrator's contract today
      // (the orchestrator always returns the structured plan; the CLI
      // shim handles rendered diff output), but pass it explicitly so
      // the intent ("MCP wants the structured plan, not a rendered
      // ANSI diff") is documented at the call site.
      const out = (await cmdOnboard({ target, mode })) as CmdOnboardPlanResult;
      const result: PlanResult = {
        plan: out.plan,
        dryRun: mode === "dry-run",
        applied: out.applied,
        branchName: out.branchName,
      };
      return {
        structuredContent: result as unknown as Record<string, unknown>,
        content: [{ type: "text", text: renderMarkdownSummary({ mode, sc: result }) }],
        annotations: { destructiveHint },
      };
    },
  );
}
