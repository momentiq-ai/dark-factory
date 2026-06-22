// packages/cli/src/handoff/handoff-verb.ts
//
// /handoff verb — port of dark-factory-platform
// .claude/skills/handoff/scripts/handoff.sh@a6f711b (390 LOC bash → TS).
//
// PRESERVES THE gh-CALL SEQUENCE BYTE-FOR-FOR-BYTE. Task 17 ports the bash
// race/drift tests via FakeGhClient.calls(); they assert the relative order:
//   1) validate gh.issueView  (slot 1 — body-bearing)
//   2) maybe gh.issueList     (no-arg path; assignee partition)
//   3) maybe gh.prListByHead  (auto-link single PR; createNew && no --link)
//   4) maybe gh.prView N      (per --link, PR-first lookup in resolveLinkRef)
//   5) maybe gh.issueView N   (per --link, issue fallback)
//   6) pre-PATCH gh.issueView (slot 2 — body-bearing, the race-safety seam)
//   7) gh.issueEditBody       (the actual PATCH)
//   8) gh.ensureHandoffLabel
//   9) gh.issueAddLabel       (load-bearing — failure = not on /handoffs stack)
//  10) gh.issueUnassignMe     (idempotent, non-fatal)
//
// The slot-1 vs slot-2 split on issueView IS the race-safety seam — drift
// between them means a concurrent /accept landed in between. Do NOT collapse.
//
// Behavioral correction from advisor (overrides the spec's Phase C step 6
// prose): the claimed-by-other advisory fires ONLY on the create-new branch
// (FORCE_NEW || eligible_count==0). The bash code (handoff.sh:151-153)
// calls _emit_others_advisory only there; the eligible_count==1 picker
// branch (handoff.sh:154-163) emits NO advisory. The message text confirms:
// "…— creating a new handoff." is false in the pick-one-and-update case.
//
// Other v2 deltas vs the v1 src/handoff/index.ts runHandoff (which this
// supersedes at Task 22):
//   - Dirty worktree → warn, not refuse (D4: no push step here).
//   - Empty-note check uses byte length (bash [ -s ]), not v1's !body.trim().
//   - Imports HandoffError + ports from ./ports.js, not the v1 module.
//   - Uses GhClient/GitClient/Clock ports (Task 4), not GhRunner/GitRunner.

import { requireIssueNumber } from "./args.js";
import {
  assigneesOtherCsv,
  assigneesStatus,
  MeLoginCache,
} from "./assignees.js";
import {
  canonicalizeLinkRef,
  extractLinkedItems,
  formatLinkEntry,
  resolveLinkRef,
} from "./links.js";
import {
  MARKER_CLOSE,
  MARKER_OPEN,
  spliceAgentContextBlock,
  validateLatestBlock,
} from "./markers.js";
import { HandoffError, type Clock, type GhClient, type GitClient } from "./ports.js";
import { scrubBody, scrubString } from "./scrub.js";

const HANDOFF_LABEL = "handoff";

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export interface RunHandoffOptions {
  readonly noteStdin: string;
  readonly issue?: number;
  readonly link?: readonly string[];
  readonly unlink?: readonly string[];
  readonly forceNew?: boolean;
  /**
   * #319 Fix C override. When true, skip the staleness guard that refuses an
   * incoming note whose `_Updated:_` date is ≥2 days before now (intentional
   * for resuming an earlier draft).
   */
  readonly reuse?: boolean;
  readonly gh: GhClient;
  readonly git: GitClient;
  readonly clock: Clock;
}

export interface RunHandoffResult {
  readonly issueNumber: number;
  readonly noteUrl: string;
  readonly created: boolean;
  /** Operator-facing warn/log lines (each line printed to stderr by the CLI). */
  readonly logs: readonly string[];
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * #319 Fix C. Extract the agent-context note's `_Updated: YYYY-MM-DD_` recency
 * date (the template's `> _Updated: <date> by <session>_` line). Returns the
 * YYYY-MM-DD, or null when the note has no parseable Updated date.
 */
function extractNoteUpdatedYmd(note: string): string | null {
  const m = /_?Updated:\s*(\d{4}-\d{2}-\d{2})/.exec(note);
  return m ? m[1]! : null;
}

/**
 * #319 Fix C. Convert a YYYY-MM-DD to a UTC epoch-day integer for whole-day
 * deltas. `Date.UTC` is pure arithmetic on its arguments (it does NOT read the
 * wall clock), so this stays deterministic — "now" comes from the injected
 * Clock, never from here. Returns null on a malformed date.
 */
function ymdToEpochDay(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  return Math.floor(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000,
  );
}

/**
 * Strip a pre-existing "Linked work items" section from the operator's
 * note. Defensive — SKILL.md tells operators not to include one, but if they
 * do, the script-maintained section replaces it.
 *
 * Mirrors the bash awk transform at handoff.sh:267-274. Five rules in
 * order: header line turns skip on and is dropped; in-skip list-item /
 * empty-marker / blank lines are dropped (blank ALSO turns skip off as a
 * consumed terminator); in-skip arbitrary line turns skip off and falls
 * through to the default print rule.
 *
 * The blank-line terminator is CONSUMED (`next` in awk), but the
 * content-line terminator is PRINTED (fall through). Preserve this
 * asymmetry — getting it wrong only surfaces in Task 21 parity snapshots.
 */
function stripOperatorLinksSection(note: string): string {
  const lines = note.split("\n");
  const out: string[] = [];
  let skip = false;
  for (const line of lines) {
    if (/^\*\*Linked work items:\*\*/.test(line)) {
      skip = true;
      continue;
    }
    if (skip && /^- (pr|issue) /.test(line)) continue;
    if (skip && /^_None linked\._/.test(line)) continue;
    if (skip && /^[\t ]*$/.test(line)) {
      skip = false;
      continue; // blank-line terminator is consumed
    }
    if (skip) {
      skip = false;
      // FALL THROUGH and print this content-line terminator.
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Inject a Linked-items section immediately before the close marker.
 *
 * PORT FROM bash awk (handoff.sh:277-287). On a line containing the close
 * marker: emit blank, the section lines, blank, then the close marker line.
 * All other lines pass through.
 */
function injectLinksBeforeClose(
  noteStripped: string,
  linksSection: string,
): string {
  const lines = noteStripped.split("\n");
  const sectionLines = linksSection.split("\n");
  const out: string[] = [];
  let injected = false;
  for (const line of lines) {
    if (!injected && line.includes(MARKER_CLOSE)) {
      out.push("");
      for (const s of sectionLines) out.push(s);
      out.push("");
      out.push(line);
      injected = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Compose the script-maintained `**Linked work items:**` section. */
function composeLinksSection(entries: readonly string[]): string {
  const out: string[] = ["**Linked work items:**"];
  if (entries.length === 0) {
    out.push("_None linked._");
  } else {
    for (const e of entries) out.push(e);
  }
  return out.join("\n");
}

/**
 * Parse a body entry `- (pr|issue) <ref> ...` → its kind + display, for
 * --unlink matching. PORT FROM bash (handoff.sh:221-222): the bash uses
 * `awk '{print $2}' / '{print $3}'` — field 2 = kind, field 3 = display.
 * Returns "" for kind/display if the line is malformed (caller treats as
 * non-matchable).
 */
function entryKindAndDisplay(line: string): { kind: string; display: string } {
  // Match bash awk default field-splitting (whitespace).
  const fields = line.split(/\s+/);
  return {
    kind: fields[1] ?? "",
    display: fields[2] ?? "",
  };
}

// ---------------------------------------------------------------------------
// runHandoff — the orchestrator.
// ---------------------------------------------------------------------------

/**
 * Put a work-stream on the handoff stack. Upserts the operator's
 * marker-bounded rehydration note as a dedicated handoff GitHub Issue body,
 * maintains its Linked-items section + label + leaves it unassigned. NO
 * `git push` (Decision D4).
 *
 * Phases mirror the bash:
 *   A: validate stdin    — markers + secret-scrub, no gh
 *   B: dirty worktree    — warn, not refuse
 *   C: resolve target    — explicit issue OR no-arg eligibility partition
 *   D: linked-items      — extract → --link (with title scrub) → --unlink → auto-link
 *   E: compose new note  — strip operator's stale section, inject script section
 *   F: PATCH or CREATE   — with pre-PATCH race-safety drift check
 */
export async function runHandoff(
  opts: RunHandoffOptions,
): Promise<RunHandoffResult> {
  const { noteStdin, gh, git, clock } = opts;
  const links = opts.link ?? [];
  const unlinks = opts.unlink ?? [];
  const forceNew = opts.forceNew === true;
  const logs: string[] = [];
  const meCache = new MeLoginCache();

  // Belt-and-braces: requireIssueNumber would refuse a non-positive integer,
  // but `opts.issue` is already typed `number | undefined`. The cli.ts layer
  // (Task 25) is expected to parse the raw arg via requireIssueNumber; this
  // call ensures programmatic callers (MCP tools, tests) get the same guard.
  if (opts.issue !== undefined) {
    requireIssueNumber(String(opts.issue));
  }

  // -------------------------------------------------------------------------
  // Phase A — validate the note (handoff.sh:58-70). NO gh calls.
  // -------------------------------------------------------------------------

  // Bash `[ -s "$NOTE" ]` — byte length, not trimmed. A whitespace-only note
  // must fall through to the marker error, not the empty-body error.
  if (noteStdin.length === 0) {
    throw new HandoffError("empty note body on stdin — nothing to post.");
  }
  if (!validateLatestBlock(noteStdin)) {
    throw new HandoffError(
      `note is missing/malformed agent-context markers (need ${MARKER_OPEN} … ${MARKER_CLOSE}) — compose per SKILL.md (single block, well-formed).`,
    );
  }
  const noteScrub = scrubBody(noteStdin, "<stdin>");
  if (!noteScrub.ok) {
    throw new HandoffError(noteScrub.refusal);
  }

  // #319 Fix C — staleness guard on the incoming note's `_Updated:_` date. A
  // note dated ≥2 days before now is likely a stale draft or a leftover file
  // from another session (the kind of input the #319 incident fed through).
  // Refuse unless opts.reuse. A note with no parseable Updated date can't be
  // checked — warn and proceed (don't block on a parse miss).
  if (opts.reuse !== true) {
    const noteUpdatedYmd = extractNoteUpdatedYmd(noteStdin);
    if (noteUpdatedYmd === null) {
      logs.push(
        "no parseable `_Updated: YYYY-MM-DD_` date in the note — skipping the staleness check (compose per SKILL.md to enable it).",
      );
    } else {
      const noteDay = ymdToEpochDay(noteUpdatedYmd);
      const todayDay = ymdToEpochDay(clock.todayYmd());
      if (noteDay !== null && todayDay !== null && todayDay - noteDay >= 2) {
        throw new HandoffError(
          `incoming note is dated ${noteUpdatedYmd} (${todayDay - noteDay} days before now) — likely a stale draft or a leftover file from another session. If this is intentional (resuming an earlier draft), pass --reuse. Otherwise re-compose a fresh note (SKILL.md). (#319 Fix C)`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Phase B — dirty worktree → warn, do not refuse (handoff.sh:72-75). D4.
  // -------------------------------------------------------------------------

  if (await git.isDirty()) {
    logs.push(
      "uncommitted tracked changes in the worktree — they won't be on a linked PR's diff. Commit/push them yourself if part of this work-stream.",
    );
  }

  // -------------------------------------------------------------------------
  // Phase C — resolve the target issue (handoff.sh:77-168).
  // -------------------------------------------------------------------------

  let createNew = false;
  let issueNum: number | undefined = opts.issue;
  let existingBody = "";
  let initialUpdatedAt: string | undefined;

  if (opts.issue !== undefined) {
    // Explicit issue path (bash:81-107). Capture state/labels/assignees/body/
    // updatedAt in one body-bearing view (slot 1).
    let view;
    try {
      view = await gh.issueView(opts.issue);
    } catch {
      throw new HandoffError(
        `can't verify issue #${opts.issue} (gh issue view failed — does it exist in this repo?).`,
      );
    }
    if (view.state === "CLOSED") {
      throw new HandoffError(
        `issue #${opts.issue} is closed — the handoff was already accepted; start a fresh one (run \`/handoff\` with no argument).`,
      );
    }
    const hasHandoffLabel = view.labels.some((l) => l.name === HANDOFF_LABEL);
    existingBody = view.body;
    if (!hasHandoffLabel) {
      if (existingBody.length > 0) {
        throw new HandoffError(
          `issue #${opts.issue} is not a handoff issue (no \`${HANDOFF_LABEL}\` label, non-empty body) — start a fresh handoff (\`/handoff\` with no argument), or pre-create an empty issue and apply the \`${HANDOFF_LABEL}\` label first.`,
        );
      }
      // Empty shell — accept; label added later in Phase F.
    }
    const meLogin = await meCache.resolve(gh);
    const status = assigneesStatus(view.assignees, meLogin);
    if (status === "other") {
      const others = assigneesOtherCsv(view.assignees, meLogin);
      throw new HandoffError(
        `issue #${opts.issue} is currently assigned to @${others} — coordinate with them or ask them to re-handoff (which un-assigns).`,
      );
    }
    initialUpdatedAt = view.updatedAt;
    issueNum = opts.issue;
  } else {
    // No-arg path (bash:108-168). Fail closed on list errors so we never
    // silently fall through to creating a duplicate of an existing handoff.
    let list;
    try {
      list = await gh.issueList({ state: "open", search: "author:@me" });
    } catch {
      throw new HandoffError(
        "could not query existing handoffs (`gh issue list` failed) — not creating/updating; re-run when gh recovers.",
      );
    }
    const meLogin = await meCache.resolve(gh);
    const eligible = list.filter(
      (it) => assigneesStatus(it.assignees, meLogin) !== "other",
    );
    const claimedByOther = list.filter(
      (it) => assigneesStatus(it.assignees, meLogin) === "other",
    );

    // Advisor correction: the claimed-by-other advisory fires ONLY on the
    // create-new branch (bash:151-153). The eligible==1 picker branch
    // (bash:154-163) emits NO advisory — the message text would be false
    // ("…— creating a new handoff" is wrong when we're updating one).
    const emitOthersAdvisory = (): void => {
      for (const other of claimedByOther) {
        const otherCsv = other.assignees.map((a) => a.login).join(",");
        logs.push(
          `the handoff you created at #${other.number} is now claimed by @${otherCsv} — creating a new handoff. To update #${other.number}'s body coordinate with @${otherCsv}.`,
        );
      }
    };

    if (forceNew || eligible.length === 0) {
      createNew = true;
      emitOthersAdvisory();
    } else if (eligible.length === 1) {
      const picked = eligible[0]!;
      issueNum = picked.number;
      // Re-fetch full snapshot via view (slot 1 — body-bearing). List body
      // can lag the view body, AND we need state/assignees/updatedAt for
      // the pre-PATCH drift check below.
      let view;
      try {
        view = await gh.issueView(picked.number);
      } catch {
        throw new HandoffError(
          `could not fetch state for #${picked.number} (gh issue view failed) — not PATCHing.`,
        );
      }
      existingBody = view.body;
      initialUpdatedAt = view.updatedAt;
      // #319 Fix B — refuse auto-discovery on link-set mismatch. The incident:
      // a no-arg `df handoff --link <refs>` auto-discovered an UNRELATED
      // session's open handoff and PATCHed it. If the operator brought --link
      // refs AND the discovered issue already has linked items AND NONE of the
      // incoming refs overlap, this is very likely a different work-stream.
      // Refuse (no mutation yet — Phase D --link resolution hasn't run). Naming
      // the issue explicitly bypasses this (it's the override); so does --new.
      // canonicalizeLinkRef does NO network call, so this is free.
      if (links.length > 0) {
        const existingDisplays = new Set(
          extractLinkedItems(existingBody)
            .map((e) => e.split(/\s+/)[2])
            .filter((d): d is string => d !== undefined && d !== ""),
        );
        if (existingDisplays.size > 0) {
          const overlap = links.some((ref) =>
            existingDisplays.has(canonicalizeLinkRef(ref).display),
          );
          if (!overlap) {
            throw new HandoffError(
              `auto-discovered open handoff #${picked.number}, but none of your --link refs overlap its existing linked work items — this looks like a different work-stream's handoff. Pass --new for a fresh issue, or name it explicitly (df handoff ${picked.number} …) to update it anyway. (#319 Fix B)`,
            );
          }
        }
      }
      logs.push(
        `updated #${picked.number} instead of creating new — pass \`--new\` to force a new issue.`,
      );
    } else {
      const nums = eligible.map((e) => `#${e.number}`).join(",");
      throw new HandoffError(
        `multiple open handoffs owned by you: ${nums} — pick one (\`/handoff <issue>\`) or pass \`--new\` to force a new issue.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Phase D — compute linked-work-items entries (handoff.sh:170-247).
  // -------------------------------------------------------------------------

  let entries: string[] = [...extractLinkedItems(existingBody)];

  // --link: resolve via gh, scrub title, dedup by "kind display" prefix.
  // Pass the source handoff number so resolveLinkRef can refuse a link that
  // would close a handoff→handoff cycle (dark-factory#229). `issueNum` is set
  // on both the explicit (`opts.issue`) and auto-picked update paths; it is
  // undefined ONLY when creating a brand-new issue (`createNew`), where no
  // cycle is possible because the source issue does not exist yet.
  for (const ref of links) {
    const resolved = await resolveLinkRef(
      ref,
      gh,
      issueNum !== undefined ? { sourceIssue: issueNum } : undefined,
    );
    const titleScrub = scrubString(
      resolved.title,
      `linked work-item title for ${resolved.display}`,
    );
    if (!titleScrub.ok) {
      throw new HandoffError(titleScrub.refusal);
    }
    const newEntry = formatLinkEntry(resolved);
    const dedupPrefix = `- ${resolved.kind} ${resolved.display} —`;
    entries = entries.filter((e) => !e.startsWith(dedupPrefix));
    entries.push(newEntry);
  }

  // --unlink: canonicalize ref (no gh fetch), drop matching entries.
  for (const ref of unlinks) {
    const canon = canonicalizeLinkRef(ref);
    entries = entries.filter((e) => {
      const { kind: eKind, display: eDisplay } = entryKindAndDisplay(e);
      if (eDisplay !== canon.display) return true;
      // Display matched. Only drop if ref had no kind hint, OR kinds also match.
      if (canon.kind === "" || canon.kind === eKind) return false;
      return true;
    });
  }

  // Auto-link single matching open PR — only when creating new AND no --link.
  if (createNew && links.length === 0) {
    const branch = await git.currentBranch();
    if (
      branch !== "" &&
      branch !== "HEAD" &&
      branch !== "main" &&
      branch !== "master"
    ) {
      const prList = await gh.prListByHead(branch);
      if (prList.length === 1) {
        const onlyPr = prList[0]!;
        const titleScrub = scrubString(
          onlyPr.title,
          `auto-linked PR #${onlyPr.number} title`,
        );
        if (!titleScrub.ok) {
          throw new HandoffError(titleScrub.refusal);
        }
        entries.push(`- pr #${onlyPr.number} — ${onlyPr.title}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Phase E — compose the new block (handoff.sh:249-287).
  // -------------------------------------------------------------------------

  const linksSection = composeLinksSection(entries);
  const noteStripped = stripOperatorLinksSection(noteStdin);
  const newBlockMd = injectLinksBeforeClose(noteStripped, linksSection);

  // -------------------------------------------------------------------------
  // Phase F — PATCH or CREATE (handoff.sh:289-390).
  // -------------------------------------------------------------------------

  if (createNew) {
    // CREATE path (bash:290-326). Title from branch (or date), scrub it, and
    // fall back to a date-only title if the branch name itself trips scrub.
    const branch = await git.currentBranch();
    const ymd = clock.todayYmd();
    let title: string;
    if (
      branch !== "" &&
      branch !== "HEAD" &&
      branch !== "main" &&
      branch !== "master"
    ) {
      title = `Handoff: ${branch}`;
    } else {
      title = `Handoff: closeout @ ${ymd}`;
    }
    const titleScrub = scrubString(title, "generated issue title for new handoff");
    if (!titleScrub.ok) {
      title = `Handoff: ${ymd} (branch name redacted by scrub)`;
      logs.push(
        "branch name matched the secret-shaped pattern set — using a date-based title instead. Rename the branch if a descriptive title is needed.",
      );
    }
    await gh.ensureHandoffLabel();
    const created = await gh.issueCreate({
      title,
      bodyMd: newBlockMd,
      label: HANDOFF_LABEL,
    });
    // gh issue create --label already applied the label; the explicit add
    // step in the PATCH path doesn't apply here. Belt-and-braces unassign
    // (idempotent; non-fatal — issueUnassignMe swallows "not assigned" per
    // its contract on the GhClient port).
    try {
      await gh.issueUnassignMe(created.number);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logs.push(`couldn't remove @me from #${created.number} (gh error): ${msg}.`);
    }
    logs.push(`created handoff issue #${created.number}: ${created.url}`);
    return {
      issueNumber: created.number,
      noteUrl: created.url,
      created: true,
      logs,
    };
  }

  // PATCH path (bash:327-390). Pre-PATCH drift check — the race-safety seam.
  if (issueNum === undefined) {
    // Defensive: createNew=false implies issueNum was set in Phase C. If we
    // reach here with no issue, the orchestrator has a logic bug.
    throw new HandoffError(
      "internal error: PATCH path reached with no target issue number.",
    );
  }
  let prePatch;
  try {
    // Slot 2 of issueView — body-bearing. Do NOT collapse with slot 1; that
    // split IS the race-safety seam (Task 17 asserts this via FakeGhClient
    // call-sequence). The drift check requires body to detect concurrent
    // writers, so this is `issueView`, not `issueViewSlim`.
    prePatch = await gh.issueView(issueNum);
  } catch {
    throw new HandoffError(
      `could not re-fetch state for race check (gh error) — not PATCHing.`,
    );
  }
  if (prePatch.state !== "OPEN") {
    throw new HandoffError(
      `issue #${issueNum} changed between fetch and intended PATCH — state is now ${prePatch.state} (concurrent \`/accept\` may have closed it). Your note was NOT posted; re-run \`/handoff\` with a fresh target if appropriate.`,
    );
  }
  const meLogin = await meCache.resolve(gh);
  if (assigneesStatus(prePatch.assignees, meLogin) === "other") {
    const others = assigneesOtherCsv(prePatch.assignees, meLogin);
    throw new HandoffError(
      `issue #${issueNum} changed between fetch and intended PATCH — now assigned to @${others} (concurrent \`/accept\` claimed it). Your note was NOT posted.`,
    );
  }
  if (prePatch.body !== existingBody) {
    throw new HandoffError(
      "issue body changed between fetch and intended PATCH — your note was NOT posted. Re-run `/handoff` to splice against the new body.",
    );
  }
  // updatedAt drift sanity: if state+assignees+body all match but updatedAt
  // changed, something else mutated (labels?) — usually benign; warn but
  // proceed. (bash:360-362)
  if (
    initialUpdatedAt !== undefined &&
    prePatch.updatedAt !== initialUpdatedAt
  ) {
    logs.push(
      `note: issue #${issueNum}.updatedAt changed since initial fetch (state/assignees/body unchanged — likely labels/metadata only). Proceeding.`,
    );
  }

  // PATCH: splice the new block into the existing body, edit, ensure label,
  // ADD label (load-bearing — failure means invisible on /handoffs), then
  // best-effort unassign (idempotent; non-fatal).
  const newBody = spliceAgentContextBlock(existingBody, newBlockMd);
  try {
    await gh.issueEditBody(issueNum, newBody);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HandoffError(`gh issue edit failed — body was NOT patched: ${msg}`);
  }
  await gh.ensureHandoffLabel();
  try {
    await gh.issueAddLabel(issueNum, HANDOFF_LABEL);
  } catch {
    // Label add is load-bearing: without it the issue won't show up on
    // /handoffs and the protocol's "leave it visible for pickup" contract
    // breaks. Hard-error so the operator knows to retry (the body PATCH
    // already landed; re-running /handoff is safe and idempotent).
    throw new HandoffError(
      `body patched but \`${HANDOFF_LABEL}\` label was NOT added (gh error) — issue #${issueNum} won't show up on /handoffs. Re-run \`/handoff ${issueNum}\` (idempotent) or add the label manually.`,
    );
  }
  try {
    await gh.issueUnassignMe(issueNum);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logs.push(
      `couldn't remove @me from #${issueNum} (gh error): ${msg}. Verify the issue is unassigned with \`gh issue view ${issueNum}\`.`,
    );
  }
  logs.push(`updated handoff issue #${issueNum}`);
  return {
    issueNumber: issueNum,
    // Parity with the CREATE branch (which returns `created.url`) — issue #73.
    // `prePatch` already fetched the full IssueView for the race-safety drift
    // check, so the html_url is in hand at zero extra cost. The fallback to
    // the bash-style `#N` short form covers fakes that don't populate `url`
    // (existing test fixtures); production gh always provides it.
    noteUrl: prePatch.url ?? `#${issueNum}`,
    created: false,
    logs,
  };
}
