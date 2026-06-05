// packages/cli/src/onboard/apply-plan.ts
//
// Dispatcher over the three writers + the dry-run renderer. The PR writer
// is a separate entry point (pr-writer.ts) because it spans subprocess
// orchestration (gh auth check + branch + commit + gh pr create) that
// doesn't belong in this hot path.
//
// Partial-failure contract (per B-D7): on any write error mid-loop, collect
// the written-so-far list + the not-written list and re-throw a
// ScaffoldApplyError. Idempotency: callers can re-run --apply after fixing
// the disk/permission issue; written files are overwritten with identical
// content; merge files re-detect the BEGIN/END block.

import { writeEmit } from "./writers/emit.js";
import { writeMerge, type MergeResult } from "./writers/merge.js";
import { writeSkip, type SkipResult } from "./writers/skip.js";
import { renderDryRun } from "./writers/dry-run-renderer.js";

import type { ScaffoldPlan } from "./scaffold-schema.js";

export type ApplyMode = "dry-run" | "apply";

export interface EmitResult {
  path: string;
  action: "emit";
  wrote: boolean;
}

export type ApplyFileResult = EmitResult | MergeResult | SkipResult;

export interface ApplyResult {
  mode: ApplyMode;
  results: ApplyFileResult[];
  rendered?: string;
}

export interface ApplyOptions {
  mode: ApplyMode;
  force?: boolean;
  color?: boolean;
  stderr?: (s: string) => void;
}

export class ScaffoldApplyError extends Error {
  written: string[];
  notWritten: string[];
  override cause: unknown;
  constructor(message: string, written: string[], notWritten: string[], cause: unknown) {
    super(message);
    this.name = "ScaffoldApplyError";
    this.written = written;
    this.notWritten = notWritten;
    this.cause = cause;
  }
}

export async function applyPlan(
  rootDir: string,
  plan: ScaffoldPlan,
  opts: ApplyOptions,
): Promise<ApplyResult> {
  if (opts.mode !== "dry-run" && opts.mode !== "apply") {
    throw new Error(
      `df onboard: applyPlan does not handle mode "${opts.mode as string}". ` +
        "For pr mode, use runPrMode(plan, ...) from pr-writer.ts.",
    );
  }

  if (opts.mode === "dry-run") {
    const renderOpts: { color?: boolean } = opts.color !== undefined ? { color: opts.color } : {};
    const rendered = await renderDryRun(rootDir, plan, renderOpts);
    const results: ApplyFileResult[] = plan.files.map((f) => {
      if (f.action === "skip") return { path: f.path, action: "skip", rationale: f.rationale, wrote: false };
      if (f.action === "emit") return { path: f.path, action: "emit", wrote: false };
      return { path: f.path, action: "merge", wrote: false, skipped: false };
    });
    return { mode: "dry-run", results, rendered };
  }

  // apply mode
  const results: ApplyFileResult[] = [];
  const written: string[] = [];
  for (let i = 0; i < plan.files.length; i++) {
    const file = plan.files[i]!;
    try {
      if (file.action === "skip") {
        results.push(await writeSkip(rootDir, file));
        continue;
      }
      if (file.action === "emit") {
        await writeEmit(rootDir, file, { force: opts.force ?? false });
        results.push({ path: file.path, action: "emit", wrote: true });
        written.push(file.path);
        continue;
      }
      // merge
      const mergeOpts: { stderr?: (s: string) => void } = opts.stderr !== undefined ? { stderr: opts.stderr } : {};
      const r = await writeMerge(rootDir, file, mergeOpts);
      results.push(r);
      if (r.wrote) written.push(file.path);
    } catch (err) {
      const notWritten = plan.files.slice(i).map((f) => f.path);
      throw new ScaffoldApplyError(
        `df onboard: write failed at ${file.path} (${err instanceof Error ? err.message : String(err)}). ` +
          `Files written before the failure: ${written.length ? written.join(", ") : "(none)"}. ` +
          `Files NOT written: ${notWritten.join(", ")}. ` +
          `Re-run \`df onboard --apply\` after addressing the disk/perm issue; ` +
          `written files will be overwritten with the same content (idempotent).`,
        written,
        notWritten,
        err,
      );
    }
  }
  return { mode: "apply", results };
}
