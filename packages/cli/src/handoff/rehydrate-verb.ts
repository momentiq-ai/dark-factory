// packages/cli/src/handoff/rehydrate-verb.ts
//
// /rehydrate — read-only catch-up on a handoff issue. PORT FROM
// dark-factory-platform .claude/skills/handoff/scripts/rehydrate.sh@a6f711b
// (76 LOC bash). Two paths:
//   - explicit issue → direct deriveRehydrateData
//   - no-arg → 2-tier resolution: (i) open + assigned-to-@me most recent,
//     (ii) fallback to closed + accepted-by-@me within 7d
//
// NO ownership change at any point — this is the verb for resuming your OWN
// in-flight work (reboot / model upgrade). To take over someone ELSE's, use
// /accept (accept-verb.ts) instead.
//
// Works on open AND closed handoff issues (closed = forensic catch-up per
// OQ-12.6).
//
// gh-call sequence — Task 19's call-sequence assertions will catch drift:
//   explicit:   gh.issueView(issue) inside deriveRehydrateData (slot 1) + per-link
//   no-arg T1:  gh.issueList(open,@me) → if found, deriveRehydrateData (slot 1)
//   no-arg T2:  gh.issueList(open,@me) → gh.issueList(closed,@me)
//                 → if within-7d, deriveRehydrateData (slot 1)
//
// Notes vs accept-verb (advisor catch — do not replicate accept's pattern):
//   - NO MeLoginCache / apiUserLogin here. The bash computes `my=$(me_login)`
//     only to silence shellcheck (`: "$my"` at rehydrate.sh:72 is dead code,
//     never used in logic). The "@me" filtering is server-side via
//     issueList({assignee: "@me"}). Adding apiUserLogin would break Task 19's
//     call-sequence assertions.
//   - NO linkFailures gate. Unlike /accept's strict mode, /rehydrate is a
//     plain pass-through to deriveRehydrateData: return whatever it derives,
//     including any UNREACHABLE linked items.
//   - NO mutations anywhere — no gh.issueAssignMe / issueClose / issueEditBody.
//
// Error-path discipline (matches accept-verb): every fatal path throws a
// HandoffError with the bash's exact `die` message (backticks + em-dash);
// `logs` only carries non-fatal warns (the tier-2 closedAt-parse skip).
// Both issueList failures fail closed (consistent with handoff.sh's no-arg
// path); a transient gh failure should be diagnosed, not silently treated as
// "no in-flight handoff".

import { isoToEpoch } from "./iso.js";
import { HandoffError, type Clock, type GhClient } from "./ports.js";
import { deriveRehydrateData, type RehydrateData } from "./rehydrate-core.js";

const REHYDRATE_CLOSED_WINDOW_DAYS = 7;

export interface RunRehydrateOptions {
  /** Explicit target issue. When omitted, runRehydrate does 2-tier no-arg
   * resolution (open+@me → closed+@me within 7d). */
  readonly issue?: number;
  readonly gh: GhClient;
  readonly clock: Clock;
}

export interface RunRehydrateResult {
  readonly issueNumber: number;
  /** Structured live state for the resolved issue. CLI prints via
   * renderRehydrateText; MCP returns as structuredContent. */
  readonly rehydrate: RehydrateData;
  /** Non-fatal operator info lines (each printed to stderr by the CLI).
   * Currently carries at most one entry: the tier-2 closedAt-parse skip warn.
   * Fatal paths put their guidance in the thrown HandoffError message. */
  readonly logs: readonly string[];
}

/**
 * Read-only catch-up on a handoff issue. NO ownership change at any point —
 * this is the verb for resuming your OWN in-flight work; /accept is for
 * taking over someone else's.
 *
 * Explicit-issue path is a thin wrapper around deriveRehydrateData (which
 * already throws HandoffError on a bad/unreachable issue, so no extra error
 * wrapping is needed). No-arg path does 2-tier resolution per spec §4.4
 * step 1; both tiers fail-closed on `gh issue list` errors.
 */
export async function runRehydrate(
  opts: RunRehydrateOptions,
): Promise<RunRehydrateResult> {
  const { gh, clock } = opts;
  const logs: string[] = [];
  let issue: number | undefined = opts.issue;

  if (issue === undefined) {
    // --- Tier 1: most recent open handoff-labeled issue assigned to @me ---
    // Fail closed on list error (consistent with handoff.sh's no-arg path).
    let tier1List;
    try {
      tier1List = await gh.issueList({ state: "open", assignee: "@me" });
    } catch {
      throw new HandoffError(
        "could not query in-flight handoffs (`gh issue list` failed) — re-run when gh recovers.",
      );
    }
    const tier1Sorted = [...tier1List].sort((a, b) =>
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    );
    const tier1 = tier1Sorted[0];

    if (tier1) {
      issue = tier1.number;
    } else {
      // --- Tier 2: most recent CLOSED handoff-labeled issue accepted by @me
      // within REHYDRATE_CLOSED_WINDOW_DAYS days ---
      let tier2List;
      try {
        tier2List = await gh.issueList({ state: "closed", assignee: "@me" });
      } catch {
        throw new HandoffError(
          "could not query closed handoffs (`gh issue list` failed) — re-run when gh recovers.",
        );
      }
      const tier2Sorted = [...tier2List].sort((a, b) =>
        (b.closedAt ?? "").localeCompare(a.closedAt ?? ""),
      );
      const tier2 = tier2Sorted[0];

      if (tier2 && tier2.closedAt) {
        // Robust ISO-8601 → epoch (handles Z, +HH:MM, and fractional seconds).
        // undefined = parse failure (NOT pre-cutoff); warn + skip so the
        // operator sees why tier-2 didn't engage. Bash parity: rehydrate.sh:62.
        const candEpoch = isoToEpoch(tier2.closedAt);
        if (candEpoch === undefined) {
          logs.push(
            `could not parse closedAt timestamp '${tier2.closedAt}' — skipping tier-2 closed-handoff fallback for #${tier2.number}.`,
          );
        } else {
          const cutoffEpoch =
            clock.nowEpoch() - REHYDRATE_CLOSED_WINDOW_DAYS * 86400;
          if (candEpoch >= cutoffEpoch) {
            issue = tier2.number;
          }
        }
      }
    }

    if (issue === undefined) {
      throw new HandoffError(
        `no in-flight handoff (open + assigned-to-@me) and no recent closed handoff (within ${REHYDRATE_CLOSED_WINDOW_DAYS}d) — see \`/handoffs\` for the unassigned stack, or \`/handoff\` to start a new one.`,
      );
    }
  }

  // Delegate to the shared core. deriveRehydrateData throws HandoffError on
  // a wholesale issueView failure — pass through for the explicit-arg path
  // (no extra wrapping needed) and the resolved-from-no-arg path alike.
  const rehydrate = await deriveRehydrateData(issue, gh);
  return { issueNumber: issue, rehydrate, logs };
}
