// `df verify` — run the armed verification routes and write SHA + diffHash-
// bound evidence. The first-class CLI graduation of the route-runner library
// (`runRoutes`) — momentiq-ai/dark-factory#192.
//
// `df verify` is the route ORCHESTRATOR. For the commit's diff it arms the
// verification routes (table floor ∪ planner, minus exclusive suppression)
// and runs each route's producer command, writing per-SHA
// `QualityGateEvidence` stamped with the gated `diffHash` — the producer half
// of #194's content binding, so `enforceVerificationRoutes` can re-validate
// the evidence against the diff it was produced for.
//
// It is NOT a per-route producer. The default routes ship the non-executable
// placeholder `df verify --route <id>` as their `command`; `runRoutes`'
// recursion guard refuses to spawn one (it would re-enter `df verify` →
// `runRoutes` forever). A consumer overrides each `command` with its own
// toolchain's producer in `.agent-review/config.json`. See
// `DEFAULT_VERIFICATION_ROUTES` and the per-evidenceKind reusable producers
// (e.g. the Playwright UI route, #193).
//
// Exit codes follow the 0/1/2 route contract:
//   0  every ran route is green (or nothing was triggered)
//   1  at least one ran route BLOCKED (exit 1, or indeterminate), OR a
//      config/usage error that prevents producing evidence (un-overridden
//      placeholder, config load failure, bad commit ref)
//   2  no route blocked but at least one SOFT-SKIPPED (tool unreachable),
//      OR a flag/usage error (mirrors `df show`/`df status`)
import { loadAgentReviewConfig } from "../policy/config.js";
import { collectChangedPaths } from "../evidence/index.js";
import { runRoutes } from "../evidence/route-runner.js";
import {
  changedFiles,
  commitDiff,
  commitParent,
  diffHash,
  resolveCommit,
} from "../git.js";

export interface VerifyIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

interface VerifyOptions {
  commit: string;
  route: string | null;
  cwd: string;
}

const HELP = [
  "df verify — run the armed verification routes and write diffHash-bound evidence.",
  "",
  "Usage:",
  "  df verify [--commit <ref>] [--route <id>] [--cwd <path>]",
  "",
  "Arms the verification routes triggered by the commit's diff (the same set",
  "`df gate-push` enforces), runs each route's producer command, and writes",
  "per-SHA evidence to .git/agent-reviews/quality-gates/<sha>.json stamped",
  "with the gated diff hash — so the gate can re-validate it against the diff",
  "it was produced for.",
  "",
  "`df verify` is the route ORCHESTRATOR, not a per-route producer: the default",
  "routes ship `df verify --route <id>` as a NON-EXECUTABLE placeholder. Each",
  "consumer overrides a route's `command` in .agent-review/config.json with",
  "its own toolchain's producer (e.g. `terraform plan`, the Playwright UI",
  "route). Running an un-overridden placeholder fails fast (it would recurse).",
  "",
  "Flags:",
  "  --commit <ref>  Commit ref (anything `git rev-parse` accepts; default HEAD).",
  "  --route <id>    Run only this route (filtered to the armed set — a route",
  "                  the diff did not trigger produces nothing).",
  "  --cwd <path>    Repository root to operate in (default: process cwd).",
  "  --help, -h      Show this message.",
  "",
  "Exit codes:",
  "  0  every ran route passed (or nothing was triggered)",
  "  1  a route blocked, or a config error (e.g. an un-overridden placeholder)",
  "  2  a route soft-skipped (tool unreachable), or a usage error",
  "",
].join("\n");

function parseVerifyArgs(rest: string[]): VerifyOptions | { error: string } {
  let commit = "HEAD";
  let route: string | null = null;
  let cwd = process.cwd();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a === "--commit") {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { error: "--commit requires a value (e.g. --commit HEAD)." };
      }
      commit = next;
      i++;
      continue;
    }
    if (a.startsWith("--commit=")) {
      commit = a.slice("--commit=".length);
      continue;
    }
    if (a === "--route") {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { error: "--route requires a value (e.g. --route playwright)." };
      }
      route = next;
      i++;
      continue;
    }
    if (a.startsWith("--route=")) {
      route = a.slice("--route=".length);
      continue;
    }
    if (a === "--cwd") {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { error: "--cwd requires a value (a path)." };
      }
      cwd = next;
      i++;
      continue;
    }
    if (a.startsWith("--cwd=")) {
      cwd = a.slice("--cwd=".length);
      continue;
    }
    return { error: `unknown flag or positional arg: ${a}` };
  }
  return { commit, route, cwd };
}

// `commitParent` throws on a root/shallow commit; an empty parent makes the
// git helpers fall back to `git show` (the commit-introduces-everything case).
async function safeParent(sha: string, cwd: string): Promise<string> {
  try {
    return await commitParent(sha, cwd);
  } catch {
    return "";
  }
}

export async function cmdVerify(rest: string[], io: VerifyIo): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    io.stdout(`${HELP}`);
    return 0;
  }
  const parsed = parseVerifyArgs(rest);
  if ("error" in parsed) {
    io.stderr(`df verify: ${parsed.error}\nRun \`df verify --help\` for usage.\n`);
    return 2;
  }

  let loaded;
  try {
    loaded = await loadAgentReviewConfig({ cwd: parsed.cwd });
  } catch (err) {
    io.stderr(`df verify: ${(err as Error).message}\n`);
    return 1;
  }

  const table = loaded.config.validation.verificationRoutes ?? [];

  // Validate `--route <id>` against the configured table so an UNKNOWN id is a
  // clear usage error (exit 2), distinct from a KNOWN route the diff did not
  // trigger (exit 0, nothing to verify). v1 runs no planner, so the table is
  // the universe of route ids.
  if (parsed.route !== null && !table.some((r) => r.id === parsed.route)) {
    io.stderr(
      `df verify: unknown route "${parsed.route}". Configured routes: ${
        table.map((r) => r.id).join(", ") || "(none)"
      }.\nRun \`df verify --help\` for usage.\n`,
    );
    return 2;
  }

  let sha: string;
  try {
    sha = await resolveCommit(parsed.commit, parsed.cwd);
  } catch (err) {
    io.stderr(`df verify: ${(err as Error).message}\n`);
    return 1;
  }

  const parent = await safeParent(sha, parsed.cwd);
  const files = await changedFiles(parent, sha, parsed.cwd, { readContent: false });
  const changedPaths = collectChangedPaths(files);

  // Compute the gated diff hash over the SAME parent..sha range the routes are
  // armed against, so `runRoutes` stamps it onto the evidence (the producer
  // half of #194). KNOWN LIMITATION: a transient git error here leaves the
  // evidence SHA-only, and the gate then falls back to SHA-only binding for
  // this commit — the teeth go dormant rather than fail the run. Mirrors the
  // same fallback in `runner.ts`'s gate path; documented, not absolute.
  let gatedDiffHash: string | undefined;
  try {
    gatedDiffHash = diffHash(await commitDiff(parent, sha, parsed.cwd));
  } catch {
    gatedDiffHash = undefined;
  }

  let summary;
  try {
    summary = await runRoutes({
      loaded,
      commit: sha,
      changedPaths,
      cwd: parsed.cwd,
      ...(gatedDiffHash !== undefined ? { diffHash: gatedDiffHash } : {}),
      ...(parsed.route !== null ? { routeFilter: parsed.route } : {}),
    });
  } catch (err) {
    // The recursion guard (un-overridden placeholder) and any other hard
    // producer error land here — fail closed with the actionable message.
    io.stderr(`df verify: ${(err as Error).message}\n`);
    return 1;
  }

  const short = sha.slice(0, 12);
  if (summary.ran.length === 0) {
    if (parsed.route !== null) {
      io.stdout(
        `df verify: route "${parsed.route}" is not triggered by ${short}'s diff (or is suppressed) — nothing to verify.\n`,
      );
    } else if (summary.suppressedBy !== undefined) {
      io.stdout(
        `df verify: routes suppressed by exclusive route "${summary.suppressedBy}" — nothing to verify (${short}).\n`,
      );
    } else {
      io.stdout(
        `df verify: no verification routes triggered by ${short}'s diff — nothing to verify.\n`,
      );
    }
    return 0;
  }

  for (const r of summary.ran) {
    const label =
      r.outcome === "green" ? "PASS" : r.outcome === "soft-skip" ? "SKIP" : "FAIL";
    io.stdout(`  ${label} route[${r.routeId}] (${r.command}) exit=${r.exitCode}\n`);
  }
  const blocked = summary.ran.filter((r) => r.outcome === "block").length;
  const skipped = summary.ran.filter((r) => r.outcome === "soft-skip").length;
  const green = summary.ran.filter((r) => r.outcome === "green").length;
  io.stdout(
    `df verify: ${summary.ran.length} ran — ${green} green, ${blocked} blocked, ${skipped} soft-skipped (${short}).\n`,
  );
  if (gatedDiffHash !== undefined) {
    io.stdout(`  evidence bound to diff ${gatedDiffHash}\n`);
  } else {
    io.stdout(
      "  warning: gated diff hash unavailable (git error) — evidence is SHA-only; content-binding is dormant for this commit.\n",
    );
  }

  // 0/1/2 route contract: a block dominates, then a soft-skip, else green.
  if (blocked > 0) return 1;
  if (skipped > 0) return 2;
  return 0;
}
