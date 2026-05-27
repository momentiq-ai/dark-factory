// MCP prompts (pure templates) — cycle5 Phase 1 step 7.
//
// 5 prompts the cycle5 spec lists under "Prompts (MCP's third
// primitive) — pure templates, no side effects":
//
//   df.write_cycle_doc          {cycle_id, title, scope}
//   df.draft_adr                {decision, context, alternatives[]}
//   df.diagnose_critic_failure  {check_run_id}
//   df.summarize_recent_runs    {limit, repo?}
//   df.onboarding_analysis      {repo_path}
//
// The spec is explicit that prompts are PURE templates: the server
// returns populated message text; it does NOT call an LLM. The
// client (Claude Code / Cursor / Codex / Gemini) renders the
// messages and feeds them into its own model with whatever
// system-prompt / tool-set it controls.
//
// "Pure" here means no LLM invocation + no file writes + no audit
// log entries. Reading local filesystem state for context embedding
// (e.g. summarize_recent_runs reads `_runs.ndjson` to include a
// snapshot in the prompt) is within the "pure template" spirit —
// it's a deterministic read with no side effects.
//
// The side-effecting counterparts (df_cycle_doc_generate /
// df_adr_generate) that use `sampling/createMessage` to ask the
// client's LLM to actually produce content land in step 8 as
// TOOLS, not prompts.

import { resolve } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { readTelemetryEvents } from "../evidence/audit-trail.js";
import { resolveArtifactDir, telemetryPath } from "../paths.js";
import { loadAgentReviewConfig } from "../policy/config.js";

export interface RegisterPromptsOptions {
  cwd?: string;
}

function userMessage(text: string): {
  role: "user";
  content: { type: "text"; text: string };
} {
  return { role: "user", content: { type: "text", text } };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function registerPrompts(
  server: McpServer,
  opts: RegisterPromptsOptions = {},
): void {
  // -----------------------------------------------------------------
  // df.write_cycle_doc — cycle-doc skeleton
  // -----------------------------------------------------------------
  server.registerPrompt(
    "df.write_cycle_doc",
    {
      title: "Write a cycle doc",
      description:
        "Return a templated cycle-doc skeleton with frontmatter + " +
        "standard sections. The client's LLM populates the body.",
      argsSchema: {
        cycle_id: z
          .string()
          .describe(
            "Cycle id (e.g. 'cycle6' or 'cycle331.7'). Maps to the " +
              "filename `docs/roadmap/cycles/<id>-slug.md`.",
          ),
        title: z.string().describe("Short title for the cycle (after the em-dash)."),
        scope: z
          .string()
          .describe(
            "One-paragraph scope statement — what's in vs out for this cycle.",
          ),
      },
    },
    ({ cycle_id, title, scope }) => {
      const template = [
        `# ${cycle_id} — ${title}`,
        "",
        "## Status",
        "",
        "Draft. Started " + today() + ".",
        "",
        "## Scope",
        "",
        scope,
        "",
        "## Goals",
        "",
        "- TODO: enumerate the concrete outcomes this cycle delivers.",
        "",
        "## Non-goals",
        "",
        "- TODO: explicitly out-of-scope items so future PRs don't drift.",
        "",
        "## Architecture",
        "",
        "TODO: high-level shape of the change. Include diagrams or",
        "annotated code listings where they add clarity.",
        "",
        "## Security",
        "",
        "TODO: trust boundaries, secrets handling, threat model deltas.",
        "Even if 'no change', say so explicitly.",
        "",
        "## Testing",
        "",
        "TODO: unit, integration, conformance. Include a recipe for an",
        "operator to verify end-to-end.",
        "",
        "## Implementation plan",
        "",
        "TODO: ordered, bite-sized steps so each PR is reviewable.",
        "Each step should be ≤ 1k LOC.",
        "",
        "## Risks",
        "",
        "TODO: what could go wrong + mitigation.",
        "",
        "## Exit criteria",
        "",
        "TODO: the concrete checklist the cycle closes on.",
        "",
        "## Open questions",
        "",
        "TODO: unresolved decisions (or move them inline above).",
        "",
        "---",
        "",
        "Style notes (delete before committing):",
        "",
        "- Frontmatter (YAML) is optional but recommended. The cycle-doc",
        "  parser uses `---`-delimited YAML at the top of the file.",
        "- H2 section names are normalized to lower snake_case by the",
        "  parser — 'Exit criteria' → 'exit_criteria'.",
        "- Keep sections under 200 lines each. If a section is bloating,",
        "  split it into a child sub-cycle doc.",
      ].join("\n");
      return {
        description: `Cycle-doc skeleton for ${cycle_id} — ${title}`,
        messages: [userMessage(template)],
      };
    },
  );

  // -----------------------------------------------------------------
  // df.draft_adr — ADR skeleton
  // -----------------------------------------------------------------
  server.registerPrompt(
    "df.draft_adr",
    {
      title: "Draft an ADR",
      description:
        "Return a templated Architecture Decision Record skeleton " +
        "with bullet metadata + standard sections.",
      argsSchema: {
        decision: z
          .string()
          .describe(
            "One-sentence statement of the decision being made.",
          ),
        context: z
          .string()
          .describe(
            "One-paragraph context — why is this decision needed now?",
          ),
        alternatives: z
          .string()
          .describe(
            "Comma- or newline-separated list of alternatives considered. " +
              "Each is added as a bullet under the Alternatives section.",
          ),
      },
    },
    ({ decision, context, alternatives }) => {
      const altList = alternatives
        .split(/[,\n]+/)
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
      const altMarkdown =
        altList.length > 0
          ? altList.map((a) => `- ${a}`).join("\n")
          : "- TODO: list at least one alternative + why it was rejected.";
      const dateStr = today();
      const adrId = dateStr.slice(0, 7); // YYYY-MM as the ADR prefix
      const template = [
        `# ADR ${adrId} — ${decision}`,
        "",
        "- **Status:** Proposed",
        `- **Date:** ${dateStr}`,
        "- **Deciders:** TODO",
        "- **Scope:** TODO",
        "",
        "## Context",
        "",
        context,
        "",
        "## Decision",
        "",
        decision,
        "",
        "## Alternatives considered",
        "",
        altMarkdown,
        "",
        "## Consequences",
        "",
        "TODO: what becomes easier / harder after this decision lands.",
        "Include any follow-up work the decision unblocks or implies.",
        "",
        "---",
        "",
        "Style notes (delete before committing):",
        "",
        "- ADR filenames live under `docs/ADR/`. Convention:",
        "  `YYYY-MM-slug.md` so the date prefix sorts lexicographically.",
        "- The MCP `df_adr_read` tool parses the bullet metadata above",
        "  (Status, Date, Deciders, Scope, Supersedes / Supersedes (in",
        "  part)). Stick to that exact format.",
      ].join("\n");
      return {
        description: `ADR skeleton — ${decision}`,
        messages: [userMessage(template)],
      };
    },
  );

  // -----------------------------------------------------------------
  // df.diagnose_critic_failure — runbook scaffolding
  // -----------------------------------------------------------------
  server.registerPrompt(
    "df.diagnose_critic_failure",
    {
      title: "Diagnose a critic failure",
      description:
        "Return a runbook-walk prompt that guides an agent through " +
        "triaging a failed critic check.",
      argsSchema: {
        check_run_id: z
          .string()
          .describe(
            "GitHub check_run id (or any opaque handle naming the " +
              "failed run) the agent will reference.",
          ),
      },
    },
    ({ check_run_id }) => {
      const template = [
        `You are diagnosing the failed Dark Factory critic check ${check_run_id}.`,
        "",
        "Walk through the standard runbook:",
        "",
        "1. **Identify the failing critic.** Use `df_findings` against the",
        "   commit's SHA (the check's `head_sha`). Look at",
        "   `critics[i].status` — `error` or `complete` with verdict",
        "   `CHANGES_REQUESTED`.",
        "",
        "2. **Read the per-finding rule + message.** For each finding",
        "   under the failing critic, surface `severity`, `rule`, `file`,",
        "   `line`, `message`. The `message` field is the critic's cited",
        "   evidence — the concrete code or text it's calling out.",
        "",
        "3. **Get the full context if needed.** Call `df_show_run` to get",
        "   the unmodified ReviewArtifact. The full finding also has",
        "   `impact` (why this matters) and `requiredFix` (what to change).",
        "",
        "4. **Cross-check with critics config.** `df_critics_config`",
        "   shows which critics are `required: true` (gate-blocking) vs",
        "   `required: false` (shadow-mode). Failures on shadow-mode",
        "   critics are informational; failures on required critics gate",
        "   the merge.",
        "",
        "5. **Decide a path forward.**",
        "   a. **Fix the code.** Address the finding directly.",
        "   b. **Bypass with reason.** If the finding is invalid or the",
        "      blocker is non-actionable (false positive), use `df_bypass`",
        "      with a structured `reason` AND `issue_url` linking the",
        "      tracking issue.",
        "   c. **Escalate.** If the critic itself seems broken (e.g.",
        "      flagging the same line in every commit), file an issue",
        "      against the critic's adapter.",
        "",
        "Be concrete. Cite specific findings + reasons + files in your",
        "diagnosis output. Do NOT make up findings or invent files —",
        "everything you cite should be returnable from the MCP tools",
        "above.",
      ].join("\n");
      return {
        description: `Runbook for diagnosing critic check ${check_run_id}`,
        messages: [userMessage(template)],
      };
    },
  );

  // -----------------------------------------------------------------
  // df.summarize_recent_runs — embeds recent telemetry into prompt
  // -----------------------------------------------------------------
  server.registerPrompt(
    "df.summarize_recent_runs",
    {
      title: "Summarize recent critic runs",
      description:
        "Embed a snapshot of recent telemetry events into a structured " +
        "prompt + ask the client's LLM to produce an operator-friendly " +
        "summary. The server reads telemetry from disk; no LLM call.",
      argsSchema: {
        limit: z
          .string()
          .describe(
            "How many most-recent events to embed (string for prompt " +
              "API compat; parsed as int; clamped 1..500; default 25).",
          ),
      },
    },
    async ({ limit }) => {
      const cwd = resolve(opts.cwd ?? process.cwd());
      const parsedLimit = parseInt(limit, 10);
      const cap = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(500, parsedLimit))
        : 25;
      let embedded = "(no .agent-review/config.json — cannot resolve artifact dir)";
      try {
        const loaded = await loadAgentReviewConfig({ cwd });
        const artifactDir = await resolveArtifactDir(loaded);
        const path = telemetryPath(artifactDir);
        const events = readTelemetryEvents(path);
        const slice = events.slice().reverse().slice(0, cap);
        embedded = slice.length === 0
          ? "(no telemetry events recorded)"
          : slice.map((e) => JSON.stringify(e)).join("\n");
      } catch (err) {
        embedded = `(failed to read telemetry: ${(err as Error).message})`;
      }
      const template = [
        "Summarize the recent Dark Factory critic runs below.",
        "Produce a short operator-friendly markdown summary covering:",
        "",
        "  - total runs, breakdown by verdict (APPROVED / CHANGES_REQUESTED / error)",
        "  - any bypasses (cite the bypassReason verbatim — these are the",
        "    real-life override events operators want to see)",
        "  - per-critic health: which critic(s) errored repeatedly?",
        "    Which were quiet?",
        "  - notable patterns (a single SHA retried many times, a",
        "    sustained error code from one vendor, etc.)",
        "",
        "Do NOT invent fields not present in the events. Cite ts + commit",
        `for any specific event you reference. Window: most recent ${cap} events.`,
        "",
        "--- BEGIN TELEMETRY (NDJSON) ---",
        embedded,
        "--- END TELEMETRY ---",
      ].join("\n");
      return {
        description: `Recent-runs summary prompt (limit=${cap})`,
        messages: [userMessage(template)],
      };
    },
  );

  // -----------------------------------------------------------------
  // df.onboarding_analysis — template consumed by cycle2 df onboard
  // -----------------------------------------------------------------
  server.registerPrompt(
    "df.onboarding_analysis",
    {
      title: "Onboarding analysis prompt",
      description:
        "Return the analysis prompt template that the cycle2 " +
        "`df onboard` agent uses when scanning a candidate consumer " +
        "repo. Pure template — no side effects.",
      argsSchema: {
        repo_path: z
          .string()
          .describe(
            "Local filesystem path to the candidate consumer repo. The " +
              "prompt instructs the agent to scan + describe the repo's " +
              "current state; the actual scanning is done by the agent's " +
              "tools, not by this prompt.",
          ),
      },
    },
    ({ repo_path }) => {
      const template = [
        `You are analyzing the candidate consumer repo at ${repo_path} for`,
        "Dark Factory onboarding readiness.",
        "",
        "Inspect (using your filesystem-read tools — do NOT run anything):",
        "",
        "1. **Repo shape.** Language(s), build system, package manager.",
        "2. **Existing CI.** GitHub Actions workflows under `.github/`.",
        "   Look for any existing `agent-critic` / `dark-factory` jobs.",
        "3. **Hooks.** `.husky/` or `.githooks/` — is the local critic",
        "   already wired? Is `core.hooksPath` set?",
        "4. **Dark Factory artifacts.** `.agent-review/config.json` (or a",
        "   YAML variant), `.git/agent-reviews/` artifact dir.",
        "5. **Documentation.** `CLAUDE.md`, `AGENTS.md`, `README.md`. Does",
        "   the repo have agentic-collaboration guidance already?",
        "6. **Cycle docs.** `docs/roadmap/cycles/`. Does the repo follow",
        "   the cycle-doc convention?",
        "",
        "Produce a structured assessment with these sections:",
        "",
        "- **Current state.** What's already in place.",
        "- **Gaps for W3 enrollment.** What's missing to enroll in the",
        "  hosted critic.",
        "- **Recommended next step.** A single concrete action (e.g. ",
        "  'install @momentiq/dark-factory-cli + wire .husky/' or ",
        "  'add .agent-review/config.json with critic id X').",
        "",
        "Be concrete. Cite specific file paths + observed content. If",
        "anything is ambiguous, say so explicitly instead of guessing.",
      ].join("\n");
      return {
        description: `Onboarding analysis prompt for ${repo_path}`,
        messages: [userMessage(template)],
      };
    },
  );
}
