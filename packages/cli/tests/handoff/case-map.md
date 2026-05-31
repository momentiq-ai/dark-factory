# Case Map: 85 bash test cases → TS tests

Cycle 12 Phase 12.2 ports the bash handoff test suite at
`momentiq-ai/dark-factory-platform@a6f711b:.claude/skills/handoff/tests/test_handoff.sh`
(85 cases, runner at lines 1427-1511) to TypeScript. This document is the
EXPLICIT mapping so "85 ported" is an honest claim and reviewers can verify
the coverage trace.

## Statuses

- **PORTED** — direct TS port in the named verb test file. The bash test's
  intent, ordering, and side-effect assertions transfer 1:1 onto
  `FakeGhClient.calls()` / fake state assertions.
- **TRANSFORMED** — the bash surface (raw shell-metachar payload via
  `$ARGUMENTS`) is gone in TS because the CLI receives pre-split argv at the
  process boundary. The SEMANTIC concern (allow-list rejection BEFORE any
  `gh` mutation) is preserved as an `args.ts` / `requireIssueNumber` /
  `requireSafeArgs` rejection test in the matching verb file. The bash
  payload string is reused literally as the input fixture so reviewers can
  trace bash row → TS row by the payload bytes.
- **N/A** — the bash surface has no analog in the TS port. There is exactly
  one row: the `.md` heredoc-capture shape test, which exercises a
  `.claude/commands/handoff.md` shell-substitution seam that does not exist
  in the TS CLI (argv arrives pre-split from the OS). The class of concern
  (shell-injection via the slash-command entrypoint) is covered structurally
  by argv pre-splitting plus the 5 TRANSFORMED allow-list tests in the verb
  files. The `.md` command file may still exist in the skill; what's gone
  is the shell-substitution seam in the TS CLI's surface.

## Targets

Each row points to one of four verb test files created in Tasks 17-20:

- `handoff-verb.test.ts` — ports `runHandoff` (handoff-verb.ts).
- `accept-verb.test.ts` — ports `runAccept` (accept-verb.ts).
- `rehydrate-verb.test.ts` — ports `runRehydrate` (rehydrate-verb.ts).
- `handoffs-verb.test.ts` — ports `runHandoffs` (handoffs-verb.ts).

Where a bash case also exercises a module already covered by an existing
unit test (`scrub.test.ts`, `links.test.ts`, `iso.test.ts`, `markers.test.ts`,
`strip-control.test.ts`, `assignees.test.ts`), the Notes column
cross-references it, but the verb-level test still lives in the named
target file so it asserts the orchestrator's gh-call sequence end-to-end.

## /handoffs (5 cases → handoffs-verb.test.ts)

| # | bash function | TS target | Status | Notes |
|---|---|---|---|---|
| 1 | `t_handoffs_renders_rows` | handoffs-verb.test.ts | PORTED | queries open + no:assignee + handoff label, renders rows with link counts. |
| 2 | `t_handoffs_empty` | handoffs-verb.test.ts | PORTED | empty list → "stack is empty". |
| 3 | `t_handoffs_iso_timestamp_variants` | handoffs-verb.test.ts | PORTED | ISO-8601 variants (fractional, numeric offset) normalize → rows render. Cross-ref: iso.test.ts. |
| 4 | `t_handoffs_link_count_scoped_to_markers` | handoffs-verb.test.ts | PORTED | link count scoped to in-marker; stale outside-marker entries ignored. Cross-ref: links.test.ts. |
| 5 | `t_handoffs_strips_control_chars_in_title` | handoffs-verb.test.ts | PORTED | row title strips control/ESC chars (terminal-escape safety). Cross-ref: strip-control.test.ts. |

## /handoff (44 cases → handoff-verb.test.ts)

| # | bash function | TS target | Status | Notes |
|---|---|---|---|---|
| 6 | `t_handoff_noarg_no_existing_creates_new` | handoff-verb.test.ts | PORTED | no-arg + no existing → creates new dedicated issue, NO git push, prints URL. |
| 7 | `t_handoff_explicit_issue_upserts_body` | handoff-verb.test.ts | PORTED | explicit existing handoff issue → body upserted, no create, no push. |
| 8 | `t_handoff_idempotent` | handoff-verb.test.ts | PORTED | two runs on same issue with same note → bodies byte-identical modulo `_Updated:_` timestamp line. (Bash uses `check $rc` not `check $?`, hence the auto-extractor missed the spec line — the verbatim spec is "handoff: idempotent — two runs produce byte-identical bodies modulo _Updated:_".) |
| 9 | `t_handoff_refuse_closed_issue` | handoff-verb.test.ts | PORTED | refuse on closed handoff issue, no PATCH. |
| 10 | `t_handoff_refuse_non_handoff_issue` | handoff-verb.test.ts | PORTED | refuse on non-handoff issue (no handoff label, non-empty body), no PATCH. |
| 11 | `t_handoff_accept_empty_shell_issue` | handoff-verb.test.ts | PORTED | empty-shell issue (no body, no label) → accepted, body PATCH + label add. |
| 12 | `t_handoff_assignees_guard_other` | handoff-verb.test.ts | PORTED | explicit /handoff <issue> assigned to @other → refuse with coordinate message. Cross-ref: assignees.test.ts. |
| 13 | `t_handoff_assignees_guard_me_passes` | handoff-verb.test.ts | PORTED | explicit /handoff <issue> assigned to @me → passes (same actor update). |
| 14 | `t_handoff_noarg_assignees_advisory` | handoff-verb.test.ts | PORTED | no-arg + my open #101 claimed by @other → advisory + create new #102, NO #101 PATCH. |
| 15 | `t_handoff_noarg_assignees_empty_updates` | handoff-verb.test.ts | PORTED | no-arg + my open #101 (assignees empty) → updated, no create, "updated" notice. |
| 16 | `t_handoff_noarg_one_eligible_one_claimed` | handoff-verb.test.ts | PORTED | no-arg + 1 eligible (#101) + 1 claimed-by-other (#102) → updates #101, NOT "multiple". |
| 17 | `t_handoff_noarg_list_fails_closed` | handoff-verb.test.ts | PORTED | gh issue list failure → fail closed, no create, no edit. |
| 18 | `t_handoff_noarg_two_eligible_dies` | handoff-verb.test.ts | PORTED | no-arg + 2 eligible @me handoffs → die "multiple", no mutation. |
| 19 | `t_handoff_link_secret_in_title_refused` | handoff-verb.test.ts | PORTED | --link with secret-shaped title refused, no PATCH, no value echo. Cross-ref: scrub.test.ts. |
| 20 | `t_handoff_link_title_with_tab_preserved` | handoff-verb.test.ts | PORTED | tab-in-title doesn't corrupt kind/display/title split (\x1e RS delimiter, not \t). Cross-ref: links.test.ts. |
| 21 | `t_handoff_link_parse_scoped_to_markers` | handoff-verb.test.ts | PORTED | in-marker section contains canonical #103, not stale outside-marker #999. Cross-ref: links.test.ts. |
| 22 | `t_handoff_create_title_scrub` | handoff-verb.test.ts | PORTED | branch-derived title scrubbed → neutral title sent to gh, secret-shaped name not published. Cross-ref: scrub.test.ts. |
| 23 | `t_handoff_pre_patch_state_drift_detected` | handoff-verb.test.ts | PORTED | pre-PATCH state drift (concurrent /accept closed it) → abort, no PATCH. Asserts the slot-1 vs slot-2 issueView seam. |
| 24 | `t_handoff_pre_patch_assignee_drift_detected` | handoff-verb.test.ts | PORTED | pre-PATCH assignee drift (concurrent /accept claimed it) → abort, no PATCH. |
| 25 | `t_handoff_command_passes_split_args` | handoff-verb.test.ts | PORTED | Bash tests the `read -r -a` tokenization of a quoted `"$ARGUMENTS"` token; in TS the OS pre-splits argv (no tokenization seam). The OBSERVABLE outcome — issue 42 + `--link 103` both honored → body gets `- pr #103` — ports directly. Assert: `runHandoff({pr:"42", links:["103"], …})` PATCHes a body containing `- pr #103`. |
| 26 | `t_handoff_refuses_semicolon_payload` | handoff-verb.test.ts | TRANSFORMED | Bash: shell semicolon in `$ARGUMENTS` refused by allow-list before any gh call. TS: `requireIssueNumber("42; echo PWNED")` throws `HandoffError` matching `/disallowed characters/i`; no GhClient call made. Input fixture reuses the literal bash payload `'42; echo PWNED'`. |
| 27 | `t_handoff_refuses_command_sub_payload` | handoff-verb.test.ts | TRANSFORMED | Bash: `$()` command-sub in `$ARGUMENTS` refused by allow-list. TS: `requireIssueNumber("$(echo PWNED)")` throws `HandoffError` matching `/disallowed characters/i`; no GhClient call. Input fixture reuses the literal bash payload `'$(echo PWNED)'`. |
| 28 | `t_handoff_refuses_redirect_payload` | handoff-verb.test.ts | TRANSFORMED | Bash: redirect `>` metachar in `$ARGUMENTS` refused, no file written. TS: `requireIssueNumber("42 > /tmp/pwn")` throws `HandoffError` matching `/disallowed characters/i`; no GhClient call. Input fixture reuses `'42 > /tmp/pwn'`. |
| 29 | `t_handoff_md_shape_neutralizes_command_sub` | (none) | N/A | The bash test inlines the `.claude/commands/handoff.md` heredoc-capture body verbatim and execs it through `bash -c` with `$(...)`, backtick, `;`, and `>` payloads spliced where Claude Code substitutes `$ARGUMENTS`. The TS CLI does not have an intermediate shell wrapper — argv arrives pre-split from the OS — so this surface is structurally absent. The class of concern (shell injection via the slash-command entrypoint) is covered by argv pre-splitting plus the 5 TRANSFORMED allow-list tests above. |
| 30 | `t_handoff_scrub_refuses_aws` | handoff-verb.test.ts | PORTED | scrub refuses AKIA… in note body; value not echoed in error. Cross-ref: scrub.test.ts. |
| 31 | `t_handoff_scrub_refuses_provider_key` | handoff-verb.test.ts | PORTED | scrub refuses provider key (sk-ant-…); value not echoed. Cross-ref: scrub.test.ts. |
| 32 | `t_handoff_scrub_refuses_connstring` | handoff-verb.test.ts | PORTED | scrub refuses credentialed URL (scheme://u:p@host); password not echoed. Cross-ref: scrub.test.ts. |
| 33 | `t_handoff_scrub_refuses_credpath` | handoff-verb.test.ts | PORTED | scrub refuses credential path (~/.aws/credentials). Cross-ref: scrub.test.ts. |
| 34 | `t_handoff_scrub_refuses_envvar` | handoff-verb.test.ts | PORTED | scrub refuses env-var secret (AWS_SECRET_ACCESS_KEY=…); value not echoed. Cross-ref: scrub.test.ts. |
| 35 | `t_handoff_malformed_note` | handoff-verb.test.ts | PORTED | malformed note (no markers) → rejected, no PATCH. Cross-ref: markers.test.ts. |
| 36 | `t_handoff_issue_zero` | handoff-verb.test.ts | PORTED | issue "0" rejected. Cross-ref: args.test.ts. |
| 37 | `t_handoff_issue_nonnumeric` | handoff-verb.test.ts | PORTED | non-numeric issue arg rejected before any gh mutation. Cross-ref: args.test.ts. |
| 38 | `t_handoff_issue_unverifiable` | handoff-verb.test.ts | PORTED | unverifiable issue (gh issue view fails) → refuse, no PATCH. |
| 39 | `t_handoff_dirty_warns_not_refuses` | handoff-verb.test.ts | PORTED | dirty worktree → WARN + proceed (v2 has no push step); PATCH still posted. v2 delta from bash (D4). |
| 40 | `t_handoff_link_multi` | handoff-verb.test.ts | PORTED | --link 103 --link 104 --link cross-repo → body has all three entries. Cross-ref: links.test.ts. |
| 41 | `t_handoff_unlink` | handoff-verb.test.ts | PORTED | --unlink 104 removes that line; others remain. Cross-ref: links.test.ts. |
| 42 | `t_handoff_unlink_url_form` | handoff-verb.test.ts | PORTED | --unlink with URL canonicalizes + removes the targeted entry only. Cross-ref: links.test.ts. |
| 43 | `t_handoff_unlink_bare_number_no_cross_repo_overmatch` | handoff-verb.test.ts | PORTED | --unlink 103 removes #103 only (no cross-repo over-match). Cross-ref: links.test.ts. |
| 44 | `t_handoff_stdin_latest_block_malformed_refused` | handoff-verb.test.ts | PORTED | stdin with valid first + malformed latest block → refused, no PATCH. Cross-ref: markers.test.ts (latest-by-position extractor). |
| 45 | `t_handoff_link_handoff_refused` | handoff-verb.test.ts | PORTED | --link to handoff-labeled issue refused with no-link-cycles message. Cross-ref: links.test.ts. |
| 46 | `t_handoff_link_url_with_query_string_allowed` | handoff-verb.test.ts | PORTED | --link URL with `?query=string` accepted, parsed, linked. Cross-ref: links.test.ts. |
| 47 | `t_handoff_link_project_url_deferred` | handoff-verb.test.ts | PORTED | --link project URL refused with explicit "deferred to Phase 12.2" message, no PATCH. Cross-ref: links.test.ts. |
| 48 | `t_handoff_auto_link_single_pr` | handoff-verb.test.ts | PORTED | no-arg + single matching open PR → auto-linked in created issue body. Hits the prListByHead seam (slot 3 of the gh-call sequence). |
| 49 | `t_handoff_body_drift_detected` | handoff-verb.test.ts | PORTED | pre-PATCH re-fetch drift detected → loud warn, NO PATCH. Asserts the slot-1 vs slot-2 issueView seam (body-drift variant). |

## /rehydrate (19 cases → rehydrate-verb.test.ts)

| # | bash function | TS target | Status | Notes |
|---|---|---|---|---|
| 50 | `t_rehydrate_explicit_open_issue` | rehydrate-verb.test.ts | PORTED | live state FIRST, then reasoning; NO ownership change. |
| 51 | `t_rehydrate_closed_issue` | rehydrate-verb.test.ts | PORTED | closed handoff issue → live state shows "closed (accepted YYYY-MM-DD)"; reasoning prints. |
| 52 | `t_rehydrate_linked_items` | rehydrate-verb.test.ts | PORTED | linked items derived live (open PR / merged PR / open issue). Cross-ref: rehydrate-core.test.ts, links.test.ts. |
| 53 | `t_rehydrate_linked_items_scoped_to_markers` | rehydrate-verb.test.ts | PORTED | linked-item derivation scoped to in-marker; stale outside entries ignored. Cross-ref: links.test.ts. |
| 54 | `t_rehydrate_checkout_hint_same_repo` | rehydrate-verb.test.ts | PORTED | same-repo open PR emits `gh pr checkout <N>` (no `--repo` on the hint line). Cross-ref: rehydrate-render.test.ts. |
| 55 | `t_rehydrate_checkout_hint_cross_repo` | rehydrate-verb.test.ts | PORTED | cross-repo open PR emits `gh pr checkout <N> --repo owner/repo`. Cross-ref: rehydrate-render.test.ts. |
| 56 | `t_rehydrate_checkout_hint_skipped_for_merged` | rehydrate-verb.test.ts | PORTED | merged PR has no checkout hint. Cross-ref: rehydrate-render.test.ts. |
| 57 | `t_rehydrate_livestate_fails_hard` | rehydrate-verb.test.ts | PORTED | live-state query failure is HARD error (not soft fall-through). |
| 58 | `t_rehydrate_strips_control_chars` | rehydrate-verb.test.ts | PORTED | control/ESC chars stripped on display. Cross-ref: strip-control.test.ts. |
| 59 | `t_rehydrate_strips_control_chars_in_title` | rehydrate-verb.test.ts | PORTED | control/ESC chars stripped from issue title (terminal-escape safety). Cross-ref: strip-control.test.ts. |
| 60 | `t_rehydrate_no_marker` | rehydrate-verb.test.ts | PORTED | no marker block → live state + "no agent-context note" message. Cross-ref: markers.test.ts. |
| 61 | `t_rehydrate_nonnumeric` | rehydrate-verb.test.ts | PORTED | non-numeric issue arg rejected before any gh call. Cross-ref: args.test.ts. |
| 62 | `t_rehydrate_multiple_blocks_picks_last` | rehydrate-verb.test.ts | PORTED | multiple agent-context blocks → shows the last-by-position. Cross-ref: markers.test.ts. |
| 63 | `t_rehydrate_refuses_command_sub_payload` | rehydrate-verb.test.ts | TRANSFORMED | Bash: `$()` payload via `$ARGUMENTS` refused by allow-list. TS: `requireIssueNumber("$(echo PWNED)")` throws `HandoffError` matching `/disallowed characters/i`; no GhClient call. Input fixture reuses `'$(echo PWNED)'`. |
| 64 | `t_rehydrate_noarg_tier1_open_assigned` | rehydrate-verb.test.ts | PORTED | no-arg tier 1 → resolves to open assigned-to-@me handoff. |
| 65 | `t_rehydrate_noarg_tier1_list_fails_closed` | rehydrate-verb.test.ts | PORTED | no-arg tier-1 list failure → fail closed (not silent fall-through to tier 2). |
| 66 | `t_rehydrate_noarg_tier2_closed_recent` | rehydrate-verb.test.ts | PORTED | no-arg tier 2 → resolves to most recent closed-accepted-by-@me within 7d. |
| 67 | `t_rehydrate_noarg_tier2_iso_offset_variant` | rehydrate-verb.test.ts | PORTED | no-arg tier 2 with +00:00 offset → normalized + resolves. Cross-ref: iso.test.ts. |
| 68 | `t_rehydrate_noarg_tier2_iso_fractional_variant` | rehydrate-verb.test.ts | PORTED | no-arg tier 2 with .123Z fractional → normalized + resolves. Cross-ref: iso.test.ts. |

## /accept (17 cases → accept-verb.test.ts)

| # | bash function | TS target | Status | Notes |
|---|---|---|---|---|
| 69 | `t_accept_happy_path` | accept-verb.test.ts | PORTED | assigns @me + closes; KEEPS handoff label; rehydrates. Asserts atomic chain order: validate → rehydrate (read-only) → assign → post-assign verify → close. |
| 70 | `t_accept_refuse_closed` | accept-verb.test.ts | PORTED | refuse on closed handoff issue, no mutation. |
| 71 | `t_accept_refuse_no_label` | accept-verb.test.ts | PORTED | refuse if no handoff label (not warn-proceed). |
| 72 | `t_accept_refuse_assigned_other` | accept-verb.test.ts | PORTED | refuse if assigned to @other, no mutation. Cross-ref: assignees.test.ts. |
| 73 | `t_accept_refuse_no_marker_block` | accept-verb.test.ts | PORTED | refuse on body without agent-context markers — no mutation, no close. Cross-ref: markers.test.ts. |
| 74 | `t_accept_refuse_malformed_block` | accept-verb.test.ts | PORTED | refuse on open marker without close — no mutation. Cross-ref: markers.test.ts. |
| 75 | `t_accept_refuse_reversed_markers` | accept-verb.test.ts | PORTED | refuse on reversed markers (close before open) — no mutation, no close. Cross-ref: markers.test.ts. |
| 76 | `t_accept_refuse_stale_valid_plus_newest_malformed` | accept-verb.test.ts | PORTED | refuse on stale valid + newer malformed block — no close (matches rehydrate extractor: last-by-position). Cross-ref: markers.test.ts. |
| 77 | `t_accept_preassign_empty_to_me_drift_aborts` | accept-verb.test.ts | PORTED | empty→@me drift between validate + assign → abort (not stale-retry; allow-list does NOT cover empty→@me). |
| 78 | `t_accept_linked_pr_unreachable_aborts` | accept-verb.test.ts | PORTED | linked PR unreachable → strict rehydrate aborts, no assign, no close. |
| 79 | `t_accept_no_arg` | accept-verb.test.ts | PORTED | no arg → error, no mutation. Cross-ref: args.test.ts. |
| 80 | `t_accept_refuses_semicolon_payload` | accept-verb.test.ts | TRANSFORMED | Bash: semicolon in `$ARGUMENTS` refused by allow-list. TS: `requireIssueNumber("42; echo PWNED")` throws `HandoffError` matching `/disallowed characters/i`; no GhClient call. Input fixture reuses `'42; echo PWNED'`. |
| 81 | `t_accept_rehydrate_failure_aborts` | accept-verb.test.ts | PORTED | gh fetch failure during validate/rehydrate → abort, no mutation. |
| 82 | `t_accept_preassign_drift_detected` | accept-verb.test.ts | PORTED | pre-assign drift detected (assignees changed) → abort, no assign/close. |
| 83 | `t_accept_post_assign_multi_assignee_aborts` | accept-verb.test.ts | PORTED | post-assign verify sees multi-assignee → abort BEFORE close. |
| 84 | `t_accept_close_failure_recovery_path` | accept-verb.test.ts | PORTED | assign OK + close fail → warn "assigned but not closed" (re-runnable). |
| 85 | `t_accept_self_already_assigned_passes` | accept-verb.test.ts | PORTED | already-assigned-to-@me → drift allow-list passes, close completes (retry path). |

## Summary

- **PORTED:** 79 (direct port; bash assertions transfer 1:1 onto fake-client call/state assertions).
- **TRANSFORMED:** 5 (shell-metachar payload tests — `t_handoff_refuses_semicolon_payload`, `t_handoff_refuses_command_sub_payload`, `t_handoff_refuses_redirect_payload`, `t_rehydrate_refuses_command_sub_payload`, `t_accept_refuses_semicolon_payload` — port to `requireIssueNumber`/`requireSafeArgs` rejection tests on the same literal payload bytes; assert no GhClient call was made).
- **N/A:** 1 (`t_handoff_md_shape_neutralizes_command_sub` — the `.md` heredoc-capture shell-substitution seam has no TS analog because the TS CLI receives pre-split argv from the OS; class of concern covered structurally + by the 5 TRANSFORMED rows).
- **Total:** 79 + 5 + 1 = **85**.
