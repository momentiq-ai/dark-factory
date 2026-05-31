# Bash-output snapshots — capture recipe + provenance

These three `.txt` files are **frozen reference outputs** captured from the
bash handoff impl that lives in `momentiq-ai/dark-factory-platform`'s
`.claude/skills/handoff/` (Cycle 12.1). The TS handoff impl in this package
(`src/handoff/*`) MUST emit byte-identical stdout on the same fixed-stub +
fixed-clock inputs. `tests/handoff/parity.test.ts` (Task 21) asserts that.

Treat the snapshots as the **reference of record**: do NOT "fix" grammar or
normalize unicode. The em-dashes (`—`), middle-dots (`·`), arrow (`→`), and
the literal `linked: N items` form (yes, even when N=1) are all byte-significant.

## Provenance

| Artifact | Source |
|----------|--------|
| Captured | 2026-05-30 |
| `dark-factory-platform` HEAD | `b23865ba1578e4e2ca66aac2fb1ac374cfe26b60` (origin/main) |
| `lib.sh` last touched by | commit `b52f6eeb` (`fix(cycle12.1): cloud-critic findings`) |
| `lib.sh` blob | `018b9c293d10c512cc0a203b55fedf38bc0b9c8c` |
| `handoffs.sh` blob | `5329304a282e18025e07b786dd57f612e9184aaf` |
| `rehydrate.sh` blob | `2de2f8eb960de104cb923f93fe8e079a87ab0133` |
| `tests/bin/gh` stub blob | `f400d0432be3ea16b9c9577c9e1ca84c02a321a6` |
| `tests/bin/git` stub blob | `bd5ecf9d0da85e72b6e813ee9ce63bc31a498aad` |

## Clock pin (Task 21 must match)

`format_age` in `lib.sh` calls `date -u +%s` for "now". To make
`handoffs-list.txt` reproducible we intercept ONLY that exact invocation with
a tiny `bin/date` stub that echoes `FIXED_NOW_EPOCH` and falls through to the
real `/bin/date` for any other form (the ISO-parse forms `iso_to_epoch` uses).

**FIXED_NOW_EPOCH = `1780142400` = `2026-05-30T12:00:00Z`**

The TS parity test (Task 21) MUST construct its `FixedClock` with that exact
epoch (1780142400 seconds, or `new Date("2026-05-30T12:00:00Z")`) so the
`format_age` output ("1d ago" / "12h ago") in `handoffs-list.txt` reproduces.

`rehydrate-open.txt` and `rehydrate-closed.txt` are **clock-independent**:
`do_rehydrate` calls no `date`/`format_age` (closed-state uses `cut -c1-10`
on `closedAt`; `updatedAt` isn't rendered). They will reproduce on any clock.

## Snapshot 1: `handoffs-list.txt` — `/handoffs` with 2 rows

Tests the stack-list renderer: header + row-per-issue (with `format_age` and
`extract_linked_items` count) + footer.

```text
export PATH="$PWD/bin:$PATH"
export GH_CALLS="$PWD/gh_calls.log"           # writable; never /dev/null (stub writes counter files in $(dirname))
export FIXED_NOW_EPOCH=1780142400              # 2026-05-30T12:00:00Z
export STUB_ME="alien8d"

body_101='<!-- agent-context:v1 -->
**Linked work items:**
- pr #103 — deploy spec

why: example
<!-- /agent-context:v1 -->'

body_102='<!-- agent-context:v1 -->
no links here
<!-- /agent-context:v1 -->'

# #101 updatedAt 2026-05-29T12:00:00Z → exactly 24h before FIXED_NOW → "1d ago"
# #102 updatedAt 2026-05-30T00:00:00Z → exactly 12h before FIXED_NOW → "12h ago"
# Order matters: handoffs.sh does `sort_by(.updatedAt)` (ascending) so oldest first.
export STUB_ISSUE_LIST="$(jq -n --arg b1 "$body_101" --arg b2 "$body_102" '[
  {number:101, title:"Handoff: cycle 12.1", createdAt:"2026-05-29T12:00:00Z",
   updatedAt:"2026-05-29T12:00:00Z", body:$b1},
  {number:102, title:"Handoff: closeout",  createdAt:"2026-05-28T00:00:00Z",
   updatedAt:"2026-05-30T00:00:00Z", body:$b2}
]')"

bash scripts/handoffs.sh > handoffs-list.txt 2> handoffs-list.err
# assert exit 0 + handoffs-list.err is empty
```

Notable byte-significant quirks:
- The header arrow: `→` (U+2192).
- Row separator: ` · ` (space + U+00B7 middle-dot + space).
- Em-dash inside the linked PR title in body_101: `—` (U+2014) — irrelevant
  to this output but documented because it routes through `extract_linked_items`
  for the count, and the source CLAUDE-spec uses it everywhere.
- The literal text is `linked: 1 items` (not "1 item") and `linked: none` —
  matches `lib.sh`'s `if [ "$link_n" = "0" ]; then linked="none"; else linked="${link_n} items"; fi`.

## Snapshot 2: `rehydrate-open.txt` — `/rehydrate` on OPEN issue

Tests `do_rehydrate` happy-path against an open issue with one linked OPEN
PR. Exercises live-state block, linked-items derivation (with checkout hint),
and the reasoning block extraction + ritual footer.

```text
export PATH="$PWD/bin:$PATH"
export GH_CALLS="$PWD/gh_calls.log"
export FIXED_NOW_EPOCH=1780142400              # immaterial for rehydrate but harmless
export STUB_ME="alien8d"

# Reset any prior STUB_ISSUE_LIST
unset STUB_ISSUE_LIST
export STUB_ISSUE_NUMBER=42
export STUB_ISSUE_TITLE="Handoff: cycle12.1 impl"
export STUB_ISSUE_STATE="OPEN"
export STUB_ISSUE_ASSIGNEES=""
export STUB_ISSUE_LABELS="handoff"
export STUB_ISSUE_BODY='<!-- agent-context:v1 -->
_Updated: 2026-05-30 by claude-opus-4-7 session_

**Linked work items:**
- pr #103 — deploy spec

**Why this approach (and what I rejected):**
- example reasoning
<!-- /agent-context:v1 -->'
export STUB_PR_REFS='103|deploy spec|OPEN|CLEAN|APPROVED'

bash scripts/rehydrate.sh 42 > rehydrate-open.txt 2> rehydrate-open.err
```

Notable byte-significant lines:
- `state: open (unassigned — on the stack)` — U+2014 em-dash inside parens.
- `pr #103 — deploy spec [mergeable: CLEAN, review: APPROVED, checks: no checks]`
  — title em-dash; bracketed metadata in `key: value, key: value, …` form; the
  trailing `no checks` is the empty-statusCheckRollup rendering.
- `checkout: gh pr checkout 103` — 14-space indent (verbatim from
  `printf '              checkout: gh pr checkout %s\n'`).
- The ritual footer ends with the `checkout:` hint sentence (not a separator).

## Snapshot 3: `rehydrate-closed.txt` — `/rehydrate` on CLOSED issue (forensic)

Tests `do_rehydrate` on a closed issue (no linked items, just the reasoning
note). Used for forensic catch-up after `/accept` closed the issue. The
`closed (accepted YYYY-MM-DD)` rendering comes from `cut -c1-10` of the
`closedAt` ISO string — clock-independent.

```text
export PATH="$PWD/bin:$PATH"
export GH_CALLS="$PWD/gh_calls.log"
export FIXED_NOW_EPOCH=1780142400              # immaterial
export STUB_ME="alien8d"

# Reset any prior STUB_ISSUE_LIST + STUB_ISSUE_ASSIGNEES + STUB_PR_REFS
unset STUB_ISSUE_LIST STUB_ISSUE_ASSIGNEES STUB_PR_REFS
export STUB_ISSUE_NUMBER=88
export STUB_ISSUE_TITLE="Handoff: closed example"
export STUB_ISSUE_STATE="CLOSED"
export STUB_ISSUE_CLOSED_AT="2026-05-29T10:00:00Z"
export STUB_ISSUE_LABELS="handoff"
export STUB_ISSUE_BODY='<!-- agent-context:v1 -->
_Updated: 2026-05-29_

why: closed example
<!-- /agent-context:v1 -->'

bash scripts/rehydrate.sh 88 > rehydrate-closed.txt 2> rehydrate-closed.err
```

## Full re-capture recipe (anyone can reproduce)

```bash
# 1. Set up a working dir + import the scripts/stubs from dark-factory-platform.
DFP=/path/to/dark-factory-platform  # this can be a worktree; we just need origin/main
mkdir -p /tmp/df_c122_recap/{scripts,bin}
cd /tmp/df_c122_recap
git -C "$DFP" show origin/main:.claude/skills/handoff/scripts/lib.sh       > scripts/lib.sh
git -C "$DFP" show origin/main:.claude/skills/handoff/scripts/handoff.sh   > scripts/handoff.sh
git -C "$DFP" show origin/main:.claude/skills/handoff/scripts/accept.sh    > scripts/accept.sh
git -C "$DFP" show origin/main:.claude/skills/handoff/scripts/rehydrate.sh > scripts/rehydrate.sh
git -C "$DFP" show origin/main:.claude/skills/handoff/scripts/handoffs.sh  > scripts/handoffs.sh
git -C "$DFP" show origin/main:.claude/skills/handoff/tests/bin/gh         > bin/gh
git -C "$DFP" show origin/main:.claude/skills/handoff/tests/bin/git        > bin/git
chmod +x scripts/*.sh bin/*

# 2. Add a `date` stub that intercepts the now-query ONLY.
cat > bin/date <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "-u +%s") printf '%s\n' "${FIXED_NOW_EPOCH:?}"; exit 0 ;;
esac
exec /bin/date "$@"
EOF
chmod +x bin/date

# 3. Run each capture (commands in §"Snapshot 1/2/3" above) and confirm
#    exit 0 + the `.err` file is empty before promoting to the fixtures dir.

# 4. Diff against the committed snapshots:
diff -u packages/cli/tests/handoff/fixtures/bash-output/handoffs-list.txt    /tmp/df_c122_recap/handoffs-list.txt
diff -u packages/cli/tests/handoff/fixtures/bash-output/rehydrate-open.txt   /tmp/df_c122_recap/rehydrate-open.txt
diff -u packages/cli/tests/handoff/fixtures/bash-output/rehydrate-closed.txt /tmp/df_c122_recap/rehydrate-closed.txt
```

## Gotchas (learned the hard way)

1. **`GH_CALLS` must be a writable path** — the `gh` stub writes its per-call
   counter files into `$(dirname "$GH_CALLS")`. Setting `GH_CALLS=/dev/null`
   means counter files would go in `/dev/`, which is non-writable on macOS
   and silently leaks `Permission denied` to stderr.
2. **Capture stdout and stderr separately** — don't `2>&1`. The TS parity
   test asserts against `stdout` only (the rendered view); `log`/`warn`/`die`
   go to stderr. Asserting `.err` is empty at capture time guarantees the
   snapshot has no diagnostic-line pollution.
3. **`unset` before re-capturing** — env vars leak across captures in the
   same shell session. Always `unset STUB_*` you didn't intend to set, or
   capture each snapshot in a fresh process.
4. **The `date` stub MUST fall through for ISO parsing** — `iso_to_epoch`
   uses `date -u -d <iso> +%s` (GNU) and `date -u -j -f <fmt> <iso> +%s`
   (BSD). Only `date -u +%s` is the now-query. Intercepting more than that
   would break `iso_to_epoch` and cascade through `format_age`'s arg.
5. **Don't normalize the snapshots** — middle-dots, em-dashes, the arrow,
   and the `1 items` grammar are byte-significant references for parity. If
   Task 21 finds the TS impl outputs differ on those, fix the TS impl —
   never edit these files to match TS.
