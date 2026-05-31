// packages/cli/src/handoff/accept-verb.ts
//
// /accept atomic chain. PORT FROM dark-factory-platform .claude/skills/handoff/
// scripts/accept.sh@a6f711b (147 LOC). All read-only work precedes mutations;
// a failed step leaves the issue unassigned + open on the stack.
//
// gh call sequence (the load-bearing race-safety contract — Task 18 asserts
// this order via FakeGhClient.calls()):
//   step 1: gh.issueView(issue)       — slot 1 (body-bearing)
//                  ↓
//           gh.apiUserLogin()         — lazy; first assigneesStatus(…, me)
//                                       triggers it, matching bash which
//                                       calls `me_login` inside the FIRST
//                                       assignees_status (lib.sh:88) → not
//                                       before step 1. Eager resolution would
//                                       reorder apiUserLogin ahead of
//                                       issueView and break step-1-failure
//                                       tests + the call-sequence assertion.
//   step 3: gh.issueView(issue)       — slot 2 (body-bearing; inside
//                                       deriveRehydrateData)
//           + per-linked-item gh.prView or gh.issueView (linked-item counter)
//   step 4: gh.issueViewSlim(issue)   — slot 1 (body-less)
//   step 5: gh.issueAssignMe(issue)
//   step 6: gh.issueViewSlim(issue)   — slot 2 (body-less)
//   step 7: gh.issueClose(issue)
//
// Both step 4 and step 6 use issueViewSlim — that's a separate counter from
// the body-bearing slots (validates step 1 vs the strict-rehydrate step 3).
//
// Error-path discipline (advisor catch #1): bash prints `warn "…"` to stderr
// BEFORE `exit 1`, so the operator sees the detailed guidance ("re-run
// /accept", "coordinate with @other", etc.). The HandoffError shape is
// frozen to the v1 surface (message + savedNotePath) for the Tasks 11-22
// window — there is no field to carry an extra "log line" past a throw. So
// on every fatal path we throw the DETAILED message itself, and `logs` only
// carries the two SUCCESS-path info lines that actually reach the return
// (matches handoff-verb.ts's discipline).

import {
  assigneesOtherCsv,
  assigneesStatus,
  MeLoginCache,
  type ClaimStatus,
} from "./assignees.js";
import { validateLatestBlock } from "./markers.js";
import { HandoffError, type GhClient } from "./ports.js";
import { deriveRehydrateData, type RehydrateData } from "./rehydrate-core.js";

const HANDOFF_LABEL = "handoff";

export interface RunAcceptOptions {
  readonly issue: number;
  readonly gh: GhClient;
}

export interface RunAcceptResult {
  readonly issueNumber: number;
  /**
   * Rehydrate data — CLI prints via renderRehydrateText (Task 10), MCP
   * returns as structuredContent.
   */
  readonly rehydrate: RehydrateData;
  /**
   * Success-path operator info lines (each printed to stderr by the CLI).
   * Contains exactly the two `log "…"` lines from accept.sh that fire on
   * the success path: the assign confirmation (step 5) and the close
   * confirmation (step 7). Fatal paths put their guidance in the thrown
   * HandoffError message, not here.
   */
  readonly logs: readonly string[];
}

/**
 * Take the baton on a handoff issue. Validates → refuses-on-other →
 * strict-rehydrates → drift-checks → assigns → verifies → closes. Any failure
 * before step 5 leaves the issue untouched on the stack; a failure between
 * step 5 and step 7 leaves the issue open + assigned-to-@me (re-run is
 * idempotent via the updatedAt close-failure retry path in step 4).
 */
export async function runAccept(
  opts: RunAcceptOptions,
): Promise<RunAcceptResult> {
  const { issue, gh } = opts;
  const logs: string[] = [];
  const meCache = new MeLoginCache();

  // --- step 1: validate (read-only) ----------------------------------------
  let view;
  try {
    view = await gh.issueView(issue);
  } catch {
    throw new HandoffError(
      `could not fetch issue #${issue} (gh error) — not mutating.`,
    );
  }
  if (view.state === "CLOSED") {
    throw new HandoffError(
      `issue #${issue} is closed — the handoff was already accepted.`,
    );
  }
  // (view.state is typed `"OPEN" | "CLOSED"` so the bash's catch-all
  // "unexpected state" branch is unreachable here; left out.)
  const hasHandoffLabel = view.labels.some((l) => l.name === HANDOFF_LABEL);
  if (!hasHandoffLabel) {
    throw new HandoffError(
      `issue #${issue} is not a handoff issue (no \`${HANDOFF_LABEL}\` label).`,
    );
  }
  // The body MUST carry a parseable LATEST agent-context block (matches the
  // extractor `do_rehydrate` uses — see bash:64-70). A stale-valid + new-
  // malformed body would pass a first-block check yet render no reasoning,
  // and accept would close the handoff while losing the artifact it's
  // supposed to preserve.
  if (!validateLatestBlock(view.body)) {
    throw new HandoffError(
      `issue #${issue} has no parseable agent-context block in the body (missing, malformed, or reversed markers — or the latest block is malformed) — refusing to accept (and close) a handoff with no reasoning artifact. Use \`/handoff ${issue}\` to add a well-formed note first.`,
    );
  }

  // Lazy me-login (advisor catch #2): bash calls `me_login` inside the FIRST
  // `assignees_status` call (lib.sh:88), which happens AFTER the step-1
  // issue view. Resolving here — after the view + body validation, just
  // before we need it — matches bash's gh call order. Eager resolution at
  // the top of runAccept would reorder apiUserLogin ahead of issueView in
  // FakeGhClient.calls() AND fire on step-1-failure paths where bash never
  // hits `gh api user`.
  const me = await meCache.resolve(gh);
  const initialAssignees = view.assignees;
  const initialUpdatedAt = view.updatedAt;
  const initialStatus: ClaimStatus = assigneesStatus(initialAssignees, me);

  // --- step 2: refuse if assigned to @other --------------------------------
  if (initialStatus === "other") {
    const others = assigneesOtherCsv(initialAssignees, me);
    throw new HandoffError(
      `issue #${issue} is currently assigned to @${others} — coordinate with them or ask them to re-handoff (which un-assigns).`,
    );
  }

  // --- step 3: strict rehydrate (read-only — abort the chain on failure) ---
  // deriveRehydrateData internally calls gh.issueView (slot 2, body-bearing)
  // then sequentially per linked item. It throws HandoffError on the
  // wholesale issueView failure path; we add the strict linkFailures>0 gate.
  const rehydrate = await deriveRehydrateData(issue, gh);
  if (rehydrate.linkFailures > 0) {
    throw new HandoffError(
      `rehydrate failed for #${issue} — leaving on the stack; no mutation.`,
    );
  }

  // --- step 4: pre-assign drift check --------------------------------------
  // issueViewSlim — separate seam from the body-bearing issueView slots
  // above. Slot 1 of the SLIM counter.
  let driftView;
  try {
    driftView = await gh.issueViewSlim(issue);
  } catch {
    throw new HandoffError(
      `could not re-fetch issue #${issue} for drift check — not mutating.`,
    );
  }
  if (driftView.state !== "OPEN") {
    throw new HandoffError(
      `issue #${issue} changed between validation and assign — state is now ${driftView.state}. Another receiver may have claimed it; re-run \`/accept\` to retry against the new state, or check \`/handoffs\` for the current stack.`,
    );
  }
  const driftStatus = assigneesStatus(driftView.assignees, me);
  if (driftStatus === "other") {
    throw new HandoffError(
      `issue #${issue} changed between validation and assign — another receiver may have claimed it; re-run \`/accept\` to retry against the new state, or check \`/handoffs\` for the current stack.`,
    );
  }
  // updatedAt drift handling. The close-failure retry path is the ONLY one
  // allowed to pass with updatedAt drift, and it requires INITIAL was
  // already @me (assign happened on a previous attempt, close failed). If
  // INITIAL was empty and updatedAt drifted to @me, that's a concurrent
  // assignment by another tool/automation/same-account session — abort, do
  // not proceed on the stale validate snapshot.
  if (driftView.updatedAt !== initialUpdatedAt) {
    if (initialStatus === "me" && driftStatus === "me") {
      // close-failure retry path — pass through (do nothing)
    } else {
      throw new HandoffError(
        `issue #${issue} was edited between validation and assign (initial=${initialStatus}, drift=${driftStatus}) — re-run \`/accept\` to retry against the new state.`,
      );
    }
  }

  // --- step 5: assign @me (mutation 1) -------------------------------------
  try {
    await gh.issueAssignMe(issue);
  } catch {
    throw new HandoffError(
      `couldn't assign @me on #${issue} (gh error) — leaving on the stack.`,
    );
  }
  logs.push(`accepted #${issue} — assigned to you.`);

  // --- step 6: post-assign verify (multi-assignee abort path) --------------
  // Slot 2 of the SLIM counter.
  let postView;
  try {
    postView = await gh.issueViewSlim(issue);
  } catch {
    throw new HandoffError(
      `couldn't verify post-assign state on #${issue} — leaving open + assigned; don't close.`,
    );
  }
  if (assigneesStatus(postView.assignees, me) !== "me") {
    const others = assigneesOtherCsv(postView.assignees, me);
    throw new HandoffError(
      `collision detected after assign — issue #${issue} now has assignees [${others}]. Do not close. Coordinate with the other receiver(s); the operator may \`gh issue edit ${issue} --remove-assignee <other>\` or hand the baton off explicitly.`,
    );
  }

  // --- step 7: close (Commitment 10 — handoff event complete) --------------
  try {
    await gh.issueClose(issue);
  } catch {
    throw new HandoffError(
      `assigned but not closed — re-run \`/accept ${issue}\` to complete the close, or close manually as an operator-acknowledged exception.`,
    );
  }
  logs.push(`closed #${issue} — handoff event complete.`);

  return { issueNumber: issue, rehydrate, logs };
}
