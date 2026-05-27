// df_cycle_doc_generate + df_adr_generate MCP tools — cycle5 Phase 1
// step 8.
//
// The "SOTA" pattern from the cycle5 spec: the server asks the CLIENT's
// LLM (via `sampling/createMessage`) to populate a templated skeleton,
// then validates + writes the result to disk. The server itself ships
// no model dependency / no API keys / no billing surface — sampling
// shifts compute (and cost) to the client's existing LLM context.
//
// Spec output shapes (from docs/roadmap/cycles/cycle5-mcp-server.md):
//
//   df_cycle_doc_generate →
//     { path, sampling_token_usage }
//
//   df_adr_generate →
//     { path, sampling_token_usage }
//
// Both tools follow the same flow:
//   1. Build the templated prompt (the same skeleton the
//      df.write_cycle_doc / df.draft_adr prompt would return) with
//      the input args interpolated.
//   2. Estimate tokens (chars / 4). If estimate > 8000, call
//      `elicitInput` to ask the user to confirm — cost guardrail.
//   3. Call `server.server.createMessage` with the populated prompt
//      + a maxTokens budget. The client runs its LLM and returns
//      the response.
//   4. Validate the response (frontmatter present, key sections
//      present). On validation failure, return isError + the model's
//      raw response in the content so the agent can re-prompt.
//   5. Write the file to the resolved target path (cwd-relative).
//      Refuses to overwrite an existing file (callers can delete
//      first if they want a replacement). Refuses path traversal.
//   6. Return { path, sampling_token_usage }.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, normalize, resolve } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const TOKEN_ELICITATION_THRESHOLD = 8000;
const MAX_OUTPUT_TOKENS = 4096;

export interface RegisterGenerateToolsOptions {
  cwd?: string;
}

interface SamplingTokenUsage {
  /** Approximate prompt tokens — sum of input chars / 4. */
  prompt_estimate: number;
  /** Approximate completion tokens — response chars / 4. */
  completion_estimate: number;
  /** Model the client reported using. */
  model: string;
  /** stopReason from the client (maxTokens / endTurn / stopSequence / …). */
  stop_reason?: string;
}

function estimateTokens(text: string): number {
  // Rough heuristic: ~4 chars per token. Good enough for the
  // cost-guardrail threshold. Real token counting requires the
  // model's tokenizer, which the server doesn't have access to.
  return Math.ceil(text.length / 4);
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Resolve a cwd-relative target path; refuses absolute paths and
 * `..`-segment traversal so an adversarial client can't have the
 * server write to arbitrary filesystem locations.
 */
function safeResolveTarget(cwd: string, targetPath: string): string | null {
  if (isAbsolute(targetPath)) return null;
  const normalized = normalize(targetPath);
  if (normalized.startsWith("..") || normalized.includes(`${"/"}..${"/"}`)) {
    return null;
  }
  return resolve(cwd, normalized);
}

function extractText(
  content: { type?: string; text?: string } | Array<{ type?: string; text?: string }>,
): string {
  // CreateMessageResult.content is a single content block at the
  // base shape level (no-tools variant). Defensive against array
  // form just in case a future SDK bump returns array even without
  // tools.
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text ?? "")
      .join("\n");
  }
  return content.type === "text" && typeof content.text === "string"
    ? content.text
    : "";
}

function buildCycleDocPrompt(
  cycleId: string,
  title: string,
  scope: string,
): string {
  return [
    `Produce a complete Dark Factory cycle doc for ${cycleId} — ${title}.`,
    "",
    "Follow this exact structure (the on-disk parser reads YAML",
    "frontmatter + h2 sections; deviations from h2 names lose",
    "structure):",
    "",
    "1. YAML frontmatter with: title, status='draft', owner, started",
    "   (today's date), target (TBD), closed=null.",
    "2. H1 header: `# <cycle_id> — <title>`.",
    "3. H2 sections (in this order):",
    "   - Scope (use the scope arg verbatim or expand it 1-2 paragraphs)",
    "   - Goals (concrete deliverables; ≥3 bullets)",
    "   - Non-goals (explicit out-of-scope; ≥2 bullets)",
    "   - Architecture (1-2 paragraphs + any code/diagram outline)",
    "   - Security (trust boundaries + threat-model delta; 'no change'",
    "     is acceptable if explicit)",
    "   - Testing (unit / integration / conformance recipe)",
    "   - Implementation plan (ordered, ≤1k-LOC steps)",
    "   - Risks (mitigations included)",
    "   - Exit criteria (concrete checklist)",
    "   - Open questions (or 'none' if resolved inline)",
    "",
    `Scope: ${scope}`,
    "",
    "Output the full markdown ONLY — no surrounding commentary, no",
    "code fences. The server will write your output directly to a",
    ".md file.",
  ].join("\n");
}

function buildAdrPrompt(
  adrId: string,
  decision: string,
  context: string,
  alternatives: readonly string[],
): string {
  const altsText = alternatives.length === 0
    ? "(none supplied — invent at least one rejected alternative + why)"
    : alternatives.map((a, i) => `${i + 1}. ${a}`).join("\n");
  return [
    `Produce a complete Architecture Decision Record for ${adrId}.`,
    "",
    "Follow this exact structure (the on-disk parser reads h1 +",
    "bullet metadata + h2 body sections):",
    "",
    "1. H1 header: `# ADR <adrId> — <decision>` (decision is the",
    "   one-sentence statement of the decision being made).",
    "2. Bullet metadata, exactly these keys:",
    "   - **Status:** Proposed",
    "   - **Date:** (today, YYYY-MM-DD)",
    "   - **Deciders:** (infer from context if known, else 'TBD')",
    "   - **Scope:** (single line)",
    "3. H2 sections (in this order): Context, Decision, Alternatives",
    "   considered (one bullet per alternative), Consequences.",
    "",
    `Decision: ${decision}`,
    "",
    `Context: ${context}`,
    "",
    "Alternatives considered:",
    altsText,
    "",
    "Output the full markdown ONLY — no surrounding commentary, no",
    "code fences. The server will write your output directly to a",
    ".md file.",
  ].join("\n");
}

function validateCycleDoc(text: string): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!text.startsWith("---")) {
    issues.push("missing YAML frontmatter (must start with `---`).");
  }
  if (!/^#\s+cycle[\d.]+/im.test(text)) {
    issues.push("missing h1 header `# cycleN — ...`.");
  }
  for (const required of ["## Scope", "## Implementation plan", "## Exit criteria"]) {
    if (!text.includes(required)) {
      issues.push(`missing required section: ${required}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

function validateAdr(text: string): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!/^#\s+ADR\s+/im.test(text)) {
    issues.push("missing h1 header `# ADR <id> — ...`.");
  }
  if (!/- \*\*Status:\*\*/.test(text)) {
    issues.push("missing `- **Status:**` bullet.");
  }
  if (!/- \*\*Date:\*\*/.test(text)) {
    issues.push("missing `- **Date:**` bullet.");
  }
  for (const required of ["## Context", "## Decision"]) {
    if (!text.includes(required)) {
      issues.push(`missing required section: ${required}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

interface GenerationResult {
  path: string;
  sampling_token_usage: SamplingTokenUsage;
}

async function elicitTokenConfirmation(
  server: McpServer,
  toolName: string,
  estimate: number,
): Promise<boolean> {
  try {
    const result = await server.server.elicitInput({
      message:
        `${toolName} would consume ~${estimate} prompt tokens. The ` +
        `cycle5 guardrail asks for confirmation above ` +
        `${TOKEN_ELICITATION_THRESHOLD}. Proceed?`,
      requestedSchema: {
        type: "object" as const,
        properties: {
          proceed: {
            type: "boolean" as const,
            title: "Proceed with the LLM call",
            description: "Set true to continue; false to abort.",
          },
        },
        required: ["proceed"],
      },
    });
    if (result.action !== "accept") return false;
    const content = result.content as { proceed?: boolean } | undefined;
    return content?.proceed === true;
  } catch {
    // Clients that don't support elicitation throw; conservatively
    // proceed without the confirmation in that case so the tool
    // still works (the threshold is a soft guardrail, not a hard
    // gate). Logged for observability via the SDK's own diagnostics.
    return true;
  }
}

export function registerGenerateTools(
  server: McpServer,
  opts: RegisterGenerateToolsOptions = {},
): void {
  // df_cycle_doc_generate -------------------------------------------
  server.registerTool(
    "df_cycle_doc_generate",
    {
      title: "Generate a cycle doc (sampling-driven)",
      description:
        "Use the CLIENT's LLM via sampling/createMessage to populate " +
        "a cycle-doc skeleton from { cycle_id, title, scope }, " +
        "validate the result, and write it to disk. Returns the " +
        "written path + approximate token usage. Refuses to " +
        "overwrite an existing file at target_path.",
      inputSchema: {
        cycle_id: z
          .string()
          .min(1)
          .describe(
            "Cycle id, e.g. 'cycle42' or 'cycle331.7'. Used in the h1 " +
              "header and (when target_path is omitted) the filename.",
          ),
        title: z
          .string()
          .min(1)
          .describe("Short cycle title (rendered after the em-dash)."),
        scope: z
          .string()
          .min(1)
          .describe(
            "One-paragraph scope statement. The LLM is allowed to " +
              "expand it into the Scope section.",
          ),
        target_path: z
          .string()
          .optional()
          .describe(
            "Cwd-relative output path. Default: " +
              "`docs/roadmap/cycles/<cycle_id>-<slug(title)>.md`. " +
              "Absolute paths and `..`-traversal are rejected.",
          ),
      },
      outputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path to the written file (resolved against cwd).",
          ),
        sampling_token_usage: z
          .object({
            prompt_estimate: z.number(),
            completion_estimate: z.number(),
            model: z.string(),
            stop_reason: z.string().optional(),
          })
          .describe(
            "Approximate token usage — prompt + completion estimates " +
              "(chars/4) and the client-reported model. NOT exact; " +
              "the server doesn't have the model's tokenizer.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        // The tool writes a file, but the file is in a deterministic
        // location for a (cycle_id, title) pair and overwrites are
        // explicitly refused. Idempotent in the sense that running
        // the tool twice with the same input yields the same OR a
        // refusal-to-overwrite — never a different write.
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ cycle_id, title, scope, target_path }) => {
      return runGeneration({
        server,
        cwd: resolve(opts.cwd ?? process.cwd()),
        toolName: "df_cycle_doc_generate",
        promptText: buildCycleDocPrompt(cycle_id, title, scope),
        defaultPath: `docs/roadmap/cycles/${cycle_id}-${slugify(title)}.md`,
        target_path,
        validate: validateCycleDoc,
      });
    },
  );

  // df_adr_generate -------------------------------------------------
  server.registerTool(
    "df_adr_generate",
    {
      title: "Generate an ADR (sampling-driven)",
      description:
        "Use the CLIENT's LLM via sampling/createMessage to populate " +
        "an ADR skeleton from { adr_id, decision, context, " +
        "alternatives }, validate the result, and write it to disk. " +
        "Returns the written path + approximate token usage. " +
        "Refuses to overwrite.",
      inputSchema: {
        adr_id: z
          .string()
          .min(1)
          .describe(
            "ADR identifier, e.g. '2026-06-cycle-tracker-extraction'. " +
              "Used in the h1 header + (default) filename.",
          ),
        decision: z
          .string()
          .min(1)
          .describe("One-sentence statement of the decision."),
        context: z
          .string()
          .min(1)
          .describe("One-paragraph context — why is this needed now?"),
        alternatives: z
          .array(z.string())
          .min(1)
          .describe(
            "Alternatives considered. Each becomes a bullet in the " +
              "Alternatives section.",
          ),
        target_path: z
          .string()
          .optional()
          .describe(
            "Cwd-relative output path. Default: " +
              "`docs/ADR/<adr_id>.md`. Absolute paths + `..`-traversal " +
              "are rejected.",
          ),
      },
      outputSchema: {
        path: z.string(),
        sampling_token_usage: z.object({
          prompt_estimate: z.number(),
          completion_estimate: z.number(),
          model: z.string(),
          stop_reason: z.string().optional(),
        }),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ adr_id, decision, context, alternatives, target_path }) => {
      return runGeneration({
        server,
        cwd: resolve(opts.cwd ?? process.cwd()),
        toolName: "df_adr_generate",
        promptText: buildAdrPrompt(adr_id, decision, context, alternatives),
        defaultPath: `docs/ADR/${adr_id}.md`,
        target_path,
        validate: validateAdr,
      });
    },
  );
}

interface RunGenerationArgs {
  server: McpServer;
  cwd: string;
  toolName: string;
  promptText: string;
  defaultPath: string;
  target_path: string | undefined;
  validate: (text: string) => { ok: boolean; issues: string[] };
}

async function runGeneration({
  server,
  cwd,
  toolName,
  promptText,
  defaultPath,
  target_path,
  validate,
}: RunGenerationArgs): Promise<{
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
}> {
  // 1. Resolve the target path (safe-rejecting absolute + traversal).
  const requestedTarget = target_path ?? defaultPath;
  const absoluteTarget = safeResolveTarget(cwd, requestedTarget);
  if (!absoluteTarget) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `**${toolName}**: target_path rejected (must be cwd-relative, ` +
            `no '..' traversal). Got: ${requestedTarget}`,
        },
      ],
    };
  }
  if (existsSync(absoluteTarget)) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `**${toolName}**: target file already exists at ${absoluteTarget}. ` +
            `Refusing to overwrite. Delete the existing file first or pass a different target_path.`,
        },
      ],
    };
  }

  // 2. Token estimate + elicitation gate.
  const promptEstimate = estimateTokens(promptText);
  if (promptEstimate > TOKEN_ELICITATION_THRESHOLD) {
    const proceed = await elicitTokenConfirmation(server, toolName, promptEstimate);
    if (!proceed) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `**${toolName}**: aborted by user — estimated ${promptEstimate} tokens ` +
              `exceeded the ${TOKEN_ELICITATION_THRESHOLD}-token confirmation gate.`,
          },
        ],
      };
    }
  }

  // 3. Sampling — ask the client's LLM.
  let samplingResult;
  try {
    samplingResult = await server.server.createMessage({
      messages: [
        { role: "user", content: { type: "text", text: promptText } },
      ],
      maxTokens: MAX_OUTPUT_TOKENS,
    });
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `**${toolName}**: sampling/createMessage failed — ${(err as Error).message}. ` +
            `The client may not support sampling, or the user declined.`,
        },
      ],
    };
  }

  const rawText = extractText(samplingResult.content as never);
  const tokenUsage: SamplingTokenUsage = {
    prompt_estimate: promptEstimate,
    completion_estimate: estimateTokens(rawText),
    model: samplingResult.model,
    ...(samplingResult.stopReason !== undefined
      ? { stop_reason: String(samplingResult.stopReason) }
      : {}),
  };

  // 4. Validate the response.
  const { ok, issues } = validate(rawText);
  if (!ok) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `**${toolName}**: LLM response failed validation. The file was NOT written.\n` +
            `Issues: ${issues.join("; ")}\n\n` +
            `--- RAW RESPONSE (for the agent to re-prompt with) ---\n${rawText}`,
        },
      ],
    };
  }

  // 5. Write the file.
  mkdirSync(dirname(absoluteTarget), { recursive: true });
  writeFileSync(absoluteTarget, rawText, "utf8");

  // 6. Return path + token usage.
  return {
    structuredContent: {
      path: absoluteTarget,
      sampling_token_usage: tokenUsage,
    } as unknown as Record<string, unknown>,
    content: [
      {
        type: "text",
        text:
          `**${toolName}**: wrote ${absoluteTarget} ` +
          `(prompt~${tokenUsage.prompt_estimate}, completion~${tokenUsage.completion_estimate} tokens, ` +
          `model=${tokenUsage.model})`,
      },
    ],
  };
}
