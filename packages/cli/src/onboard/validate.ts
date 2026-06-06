// Cycle 15 Phase C — `checkAgentContextSet()` for `df doctor`.
//
// Walks the cycle-15 D3 required-files set (CLAUDE.md, AGENTS.md,
// .claude/settings.json, docs/PRINCIPLES.md, docs/roadmap/cycles/cycle1-*.md,
// .agent-review/config.json) UNCONDITIONALLY, then optionally validates each
// path in `context.guidanceFiles` (from the loaded AgentReviewConfig) resolves
// to a real file under `repoRoot`.
//
// Per Decision #7 (round-1 revision): the required-files walk runs regardless
// of whether `context.guidanceFiles` is configured — the D3 set is the floor.
// The guidance-file walk is opt-in: when `guidanceFiles` is undefined OR `[]`,
// a single `agent_context.guidance_not_configured` informational marker is
// emitted (passed: true, optional: true) so operators see the field was
// skipped rather than silently absent.
//
// Cycle 15 exit-criterion lines 297–303: "the post-apply check fails loudly
// when any of [list] are missing or unwired (`context.guidanceFiles` does not
// point at real files). All current repos must pass `df doctor` after this
// lands."

import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

import type { DoctorCheck } from "@momentiq/dark-factory-schemas";

export interface CheckAgentContextSetOptions {
  repoRoot: string;
  /**
   * The value of `loaded.config.context?.guidanceFiles` from the loaded
   * AgentReviewConfig. The required-files walk (CLAUDE.md, AGENTS.md, etc.)
   * runs UNCONDITIONALLY regardless of this value (per Decision #7 round-1
   * revision — the cycle 15 D3 required-files set is the floor, not gated
   * by the opt-in guidanceFiles field).
   *
   * - `undefined` or `[]` → guidance-file walk skipped; single
   *   `agent_context.guidance_not_configured` informational marker emitted.
   * - Non-empty array → each path additionally checked; failures emit
   *   `agent_context.guidance_<i>` per Decision #7.
   */
  guidanceFiles: readonly string[] | undefined;
}

interface RequiredFile {
  key: string;
  name: string;
  path: string;
  isGlob: boolean;
}

const REQUIRED_FILES: readonly RequiredFile[] = [
  { key: "claude_md", name: "CLAUDE.md", path: "CLAUDE.md", isGlob: false },
  { key: "agents_md", name: "AGENTS.md", path: "AGENTS.md", isGlob: false },
  {
    key: "claude_settings",
    name: ".claude/settings.json",
    path: ".claude/settings.json",
    isGlob: false,
  },
  {
    key: "principles",
    name: "docs/PRINCIPLES.md",
    path: "docs/PRINCIPLES.md",
    isGlob: false,
  },
  {
    key: "cycle1_bootstrap",
    name: "docs/roadmap/cycles/cycle1-*.md",
    path: "docs/roadmap/cycles",
    isGlob: true,
  },
  {
    key: "config",
    name: ".agent-review/config.json",
    path: ".agent-review/config.json",
    isGlob: false,
  },
];

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function cycle1GlobMatches(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.some((name) => /^cycle1-.*\.md$/.test(name));
  } catch {
    return false;
  }
}

const REMEDIATION =
  "run `df onboard --apply` to generate the missing agent-context files, or restore the file from version control";

export async function checkAgentContextSet(
  opts: CheckAgentContextSetOptions,
): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];

  // Required-file walk — runs UNCONDITIONALLY per Decision #7 (round-1
  // revision). The cycle 15 exit-criterion lines 297–303 say "fails loudly
  // when any of [list] are missing OR unwired"; a repo without a
  // `context.guidanceFiles` block in .agent-review/config.json should still
  // fail when CLAUDE.md is missing.
  for (const req of REQUIRED_FILES) {
    const fullPath = resolve(opts.repoRoot, req.path);
    const exists = req.isGlob
      ? await cycle1GlobMatches(fullPath)
      : await fileExists(fullPath);
    out.push(
      exists
        ? {
            name: `agent_context.${req.key}`,
            passed: true,
            detail: `${req.name} present at ${fullPath}`,
          }
        : {
            name: `agent_context.${req.key}`,
            passed: false,
            detail: `${req.name} missing at ${fullPath}`,
            remediation: REMEDIATION,
          },
    );
  }

  // Guidance-file walk — additional check, runs only when the guidanceFiles
  // field is non-empty. The field is opt-in (NOT a gate for the required-
  // files set above).
  if (opts.guidanceFiles === undefined || opts.guidanceFiles.length === 0) {
    out.push({
      name: "agent_context.guidance_not_configured",
      passed: true,
      optional: true,
      detail:
        ".agent-review/config.json has no `context.guidanceFiles` block — additional per-path validation skipped (the required-files walk above still ran).",
    });
  } else {
    for (let i = 0; i < opts.guidanceFiles.length; i++) {
      const rel = opts.guidanceFiles[i]!;
      const full = resolve(opts.repoRoot, rel);
      const exists = await fileExists(full);
      out.push(
        exists
          ? {
              name: `agent_context.guidance_${i}`,
              passed: true,
              detail: `guidanceFiles[${i}] (${rel}) resolves to ${full}`,
            }
          : {
              name: `agent_context.guidance_${i}`,
              passed: false,
              detail: `guidanceFiles[${i}] (${rel}) does not resolve to a real file under ${opts.repoRoot}`,
              remediation: `fix the path in .agent-review/config.json's context.guidanceFiles[${i}] or create the file`,
            },
      );
    }
  }

  return out;
}
