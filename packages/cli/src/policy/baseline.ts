import {
  CONFIG_RELATIVE_PATH,
  type LoadedConfig,
  loadAgentReviewConfigFromRef,
} from "./config.js";
import { changedFiles, commitParent } from "../git.js";

// Cycle 318.4 trusted-surface extension.
//
// Three different enforcement surfaces have OVERLAPPING-BUT-DIFFERENT
// concerns and therefore intentionally different path lists:
//
//   1. This file (`TRUSTED_SCRIPT_PATHS`) — paths that should trigger
//      the LOCAL critic's self-modification guard (review against
//      parent baseline). Limited to the declarative policy artifacts
//      and the two enforcement scripts + their tests + the three
//      workflows. Build-time files (Makefile, dist/, lockfiles) are
//      excluded because they're not policy code per se.
//
//   2. `.github/workflows/branch-protection-audit.yml` "Detect spec-
//      relevant changes" regex — paths that should trigger the LIVE
//      ruleset audit (PR-time). Wider than (1): covers spec.yaml +
//      ANY `.github/workflows/*.{yml,yaml}` (including `*.disabled`
//      renames) + the audit/validator scripts. Broadened in issue
//      #1385 (Codex P1 #1) so that a PR adding `[skip ci]` checks to
//      ANY workflow (e.g. `pr.yml`) cannot bypass the audit.
//
//   3. `.github/workflows/agent-critic.yml` "Detect trusted-surface
//      changes" regex — paths that could weaponize the workflow
//      runtime to exfiltrate `CURSOR_API_KEY`. Broader: includes the
//      Makefile, the entire `tools/agent-review/` source tree, and
//      `.husky/` hooks, because any of those run during gate-prepare
//      / review / gate-push with the secret in env.
//
// Codex P1 (PR #1380 review) flagged the surfaces as drifting; the
// drift is intentional. Updates to (1) MUST be considered for (2) and
// (3) too — but they don't have to match byte-for-byte.
export const TRUSTED_SCRIPT_PATHS: ReadonlySet<string> = new Set([
  "tools/branch-protection/spec.yaml",
  "scripts/ci/audit_branch_protection.py",
  "scripts/ci/test_audit_branch_protection.py",
  "scripts/ci/validate_cycle_doc.py",
  "scripts/ci/test_validate_cycle_doc.py",
  // Cycle 318.4 workflow files themselves are merge-boundary policy.
  // A commit that weakens these workflows is a policy change; force the
  // critic baseline reload AND the live ruleset audit on that PR.
  ".github/workflows/agent-critic.yml",
  ".github/workflows/cycle-doc-validation.yml",
  ".github/workflows/branch-protection-audit.yml",
]);

// The "trusted policy surface" is everything that influences a critic's
// review decision: the config itself, the configured guidance files (e.g.,
// CLAUDE.md, AGENTS.md, manifesto), and the configured prompt fragments
// (the critic's own instructions). If a commit modifies ANY of these, that
// commit is changing the standard against which it is being reviewed —
// classic self-modifying-policy vulnerability.
//
// `resolvePolicyBaseline` detects modifications to any trusted input and,
// when found, returns the parent commit's policy + a `baselineRef` telling
// `buildReviewPacket` to read guidance/fragment contents from that ref
// instead of the working tree. The new policy still ships — it just
// reviews the NEXT commit, not itself.
export interface PolicyBaseline {
  loaded: LoadedConfig;
  // When set, callers (buildReviewPacket, evaluateCommitGate) must read
  // trusted-surface inputs from this git ref, not the working tree.
  // Undefined = working-tree reads are safe (no self-modification detected).
  baselineRef?: string;
  // Files that triggered the baseline reload (informational; surfaced in
  // logs / artifact metadata so operators can see why parent policy applied).
  triggeredBy: string[];
}

// Issue #57 — severity for a trusted-surface self-modification notice.
//   - `info`: the benign, working-as-designed "reviewing against parent
//     baseline" notice (the guard fired correctly).
//   - `warn`: a genuine warning — the parent policy was unavailable so the
//     self-modification check was skipped (or an env-override typo was seen).
// A consuming runtime maps these onto its own structured logger's severity so
// the benign `info` notice does not land at `severity:ERROR` (the GKE/Cloud
// Logging pollution tracked in dark-factory-platform#81).
export type PolicyNoticeLevel = "info" | "warn";

export interface PolicyNotice {
  level: PolicyNoticeLevel;
  message: string;
}

export interface ResolveBaselineOptions {
  loaded: LoadedConfig;
  sha: string;
  cwd: string;
  // Issue #56 — config provenance. When true, the caller-injected `loaded`
  // config is AUTHORITATIVE: `resolvePolicyBaseline` returns it verbatim and
  // SKIPS the parent-ref re-read entirely (no `baselineRef`, empty
  // `triggeredBy`).
  //
  // The self-modification guard exists to stop a commit from weakening the very
  // gate config that judges it. That threat is specific to *working-tree-
  // provenance* config: in the local/CI model the gate config IS the working-
  // tree `.agent-review/config.json`, so a commit editing that file edits its
  // own gate → re-read parent. An embedding/hosted caller (the Dark Factory W3
  // worker) supplies the gate config OUT OF BAND; it is never read from the
  // customer repo. The customer's committed `.agent-review/config.json` is just
  // a file in the diff under review and has zero authority over the gate, so
  // the parent-ref re-read — which exists only to recover working-tree config —
  // is inapplicable. Setting this flag does NOT disable a safety check; it
  // states the config source. It closes both the crash (parent ref lacks the
  // injected profile → "unknown profile") AND the fail-open hazard (a customer
  // who commits their own `profiles.<name>` cannot override the injected gate).
  //
  // Default false: the CLI's own `df review` / `gate-push` never set it; only
  // a library embedder that injects `loaded` out-of-band does.
  injectedConfigAuthoritative?: boolean;
  // Issue #57 — structured sink for the trusted-surface self-modification
  // notices, each carrying an explicit `level` (info vs warn). Defaults to
  // writing the message to `process.stderr` (CLI back-compat — local `df`
  // output is unchanged). A library embedder (the W3 worker) passes a sink
  // that routes by level into its own structured logger (OTel/GCP severity)
  // and does NOT touch `process.stderr`, so the benign `info` notice stops
  // polluting severity>=ERROR alerting.
  notify?: (notice: PolicyNotice) => void;
}

export async function resolvePolicyBaseline(
  options: ResolveBaselineOptions,
): Promise<PolicyBaseline> {
  const { loaded, sha, cwd } = options;

  // Issue #56 — an authoritatively-injected config is its own baseline. Return
  // it verbatim BEFORE touching git: the parent-ref re-read recovers working-
  // tree-provenance config and is inapplicable when the embedder owns the
  // config out-of-band. See `injectedConfigAuthoritative` on the options type.
  if (options.injectedConfigAuthoritative) {
    return { loaded, triggeredBy: [] };
  }

  // Issue #57 — default sink writes the message to stderr (back-compat); the
  // `level` is consumed by an injected sink, not by the default.
  const notify = options.notify ?? ((n: PolicyNotice) => process.stderr.write(n.message));

  let parent: string;
  try {
    parent = await commitParent(sha, cwd);
  } catch {
    return { loaded, triggeredBy: [] };
  }
  if (!parent) return { loaded, triggeredBy: [] };

  const files = await changedFiles(parent, sha, cwd, { readContent: false });
  const trustedPaths = new Set<string>([
    CONFIG_RELATIVE_PATH,
    ...loaded.config.context.guidanceFiles,
    ...loaded.config.context.promptFragments,
  ]);
  const triggeredBy: string[] = [];
  for (const f of files) {
    if (trustedPaths.has(f.path) || f.path.startsWith(".agent-review/")) {
      triggeredBy.push(f.path);
      continue;
    }
    // Cycle 318.4: extend trusted-surface coverage to the branch-protection
    // spec and the two policy-enforcement scripts (and their tests). This
    // set is INTENTIONALLY NARROWER than the workflow regex in
    // `.github/workflows/branch-protection-audit.yml`'s "Detect spec-
    // relevant changes" step — issue #1385 broadened that regex to cover
    // any `.github/workflows/*.{yml,yaml}` while this set still enumerates
    // only the declarative policy artifacts + their enforcement scripts.
    // See the header comment block above for why the two surfaces drift
    // intentionally; the compensating control is that the PR-time live
    // ruleset audit catches workflow edits that don't trigger the local
    // policy-baseline reload.
    if (TRUSTED_SCRIPT_PATHS.has(f.path)) {
      triggeredBy.push(f.path);
    }
  }
  if (triggeredBy.length === 0) return { loaded, triggeredBy: [] };

  // Self-modification detected. Try to load policy from parent.
  let parentLoaded: LoadedConfig;
  try {
    // Cycle 322.7 Phase C — thread the typo-guard `warn` callback through
    // to the parent-ref load so an operator who mistyped
    // `AGENT_REVIEW_AGGREGATION_POLICY` sees the diagnostic regardless of
    // which load path the run took. Without this, the baseline-reload
    // path would silently swallow the warning (Cursor critic MEDIUM on
    // dce8fd9e). #57 — the env-override typo is a genuine `warn`-level notice;
    // adapt the message-only `warn` callback onto the leveled sink.
    parentLoaded = await loadAgentReviewConfigFromRef(loaded.repoRoot, parent, {
      warn: (m) => notify({ level: "warn", message: m }),
    });
  } catch (err) {
    // Parent has no config (commit introduces it for the first time) —
    // fall back to HEAD policy with a loud warning. Self-modification
    // check is skipped, but the warning makes this visible to operators
    // (and to the artifact, since stderr is captured by the post-commit
    // hook log).
    notify({
      level: "warn",
      message:
        `agent-review: WARNING — commit ${sha.slice(0, 12)} modifies trusted policy ` +
        `surface (${triggeredBy.join(", ")}) but parent policy is unavailable ` +
        `(${(err as Error).message}); falling back to HEAD policy. ` +
        `Self-modification check skipped.\n`,
    });
    return { loaded, triggeredBy };
  }
  notify({
    level: "info",
    message:
      `agent-review: commit ${sha.slice(0, 12)} modifies trusted policy surface ` +
      `(${triggeredBy.join(", ")}); reviewing against parent baseline ${parent.slice(0, 12)} ` +
      `to prevent self-modification.\n`,
  });
  return { loaded: parentLoaded, baselineRef: parent, triggeredBy };
}
