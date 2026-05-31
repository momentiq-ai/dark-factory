# `secret-patterns.bash-ere` — provenance

This fixture is the **single source of truth (SoT)** for the bash ERE that the
DFP handoff skill uses to scrub secret-shaped content out of handoff bodies
(via `grep -Ei` in `lib.sh`'s `scrub_secrets()`).

The line is **byte-identical** to the `SECRET_PATTERNS='...'` assignment at
**lib.sh line 124** in
[`momentiq-ai/dark-factory-platform`](https://github.com/momentiq-ai/dark-factory-platform),
captured from `origin/main` at SHA `252f4217` (the line is unchanged since
SHA `a6f711b`, the originally-referenced commit; the recipe below reproduces
the fixture from either SHA).

## Why a sidecar fixture, not a hard-coded constant?

Cross-repo SoT. The `@momentiq/dark-factory-cli` (this repo) and the
DFP handoff skill (`dark-factory-platform/.claude/skills/handoff/scripts/lib.sh`)
**must scrub identically** — otherwise a bash-side push and a TS-side push of
the same body would diverge on which leaks the platform refuses. The fixture
lets `tests/handoff/scrub.test.ts` enforce byte-equality against the source
in CI, so a DFP-side change to the pattern fails the TS-side test loudly
instead of letting drift accumulate silently.

## Re-vendor recipe

If DFP updates `SECRET_PATTERNS` (any reason — new vendor key shape, tighter
URL pattern, etc.), re-run:

```bash
git -C <path-to-dark-factory-platform> show origin/main:.claude/skills/handoff/scripts/lib.sh \
  | sed -n "s/^SECRET_PATTERNS='\(.*\)'\$/\1/p" \
  > packages/cli/tests/handoff/fixtures/secret-patterns.bash-ere
```

Then update `SECRET_PATTERNS_BASH_ERE` in `packages/cli/src/handoff/scrub.ts`
to the new literal (kept as `String.raw` so the literal `\.` escapes survive
TS string parsing), re-derive `SECRET_PATTERNS_JS` from it via the same
POSIX→JS translation, and ensure the SoT equality test stays green.

## POSIX → JS RegExp translation (load-bearing)

The bash ERE contains four POSIX bracket-class expressions that JS RegExp
**does not understand**:

| POSIX (bash ERE)    | JS RegExp equivalent |
|---------------------|----------------------|
| `[[:space:]]`       | `\s`                 |
| `[^[:space:]]`      | `\S`                 |
| `[^[:space:]/:@]`   | `[^\s/:@]`           |
| `[^[:space:]/@]`    | `[^\s/@]`            |

A naive `new RegExp(SECRET_PATTERNS_BASH_ERE, "i")` would silently miscompile
`[[:space:]]` to a character class of `[ : s p a c e ]` plus a stray `]`, so
env-var (`MY_API_KEY=value`) and connection-string (`postgres://user:pw@host`)
patterns would silently **under-match** while AKIA / `sk-` / PEM patterns
still pass. `tests/handoff/scrub.test.ts` covers each POSIX-path category so
that a naive port fails visibly.

The translation lives in `packages/cli/src/handoff/scrub.ts` as a sequence of
`.replaceAll(...)` calls on `SECRET_PATTERNS_BASH_ERE`. **Longest pattern
first** — replacing `[[:space:]]` before `[^[:space:]/:@]` would corrupt the
longer class.

## Compatibility caveat (acceptable over-match)

JS `\s` matches Unicode whitespace (no-break space, ZWSP, etc.), while POSIX
`[[:space:]]` in the default C locale is ASCII-only `[ \t\n\v\f\r]`. For a
secret-scrubber this is **safe asymmetry**: over-matching whitespace can only
make the JS scrubber more aggressive than the bash one, never less — and we
prefer to refuse a real-but-weird-whitespaced secret over leaking it.

## Cross-line asymmetry (also acceptable over-refusal)

A second safe-direction asymmetry exists between the two implementations:

- **JS** evaluates `SECRET_PATTERNS_JS.test(body)` against the **whole body**.
  `\s` in JS matches the newline character `\n`, so the env-var pattern
  `[A-Za-z0-9_]*(api[_-]?key|...)[A-Za-z0-9_]*\s*[:=]\s*\S` will fire on a
  value pasted with a literal newline between the key and the `=`
  (e.g. `API_KEY\n=value`).
- **Bash** evaluates `grep -qEi "$SECRET_PATTERNS"` **per line**, so the same
  input does not match in bash — neither `API_KEY` alone nor `=value` alone
  satisfies the full env-var alternative.

The JS scrubber therefore **over-refuses** in this corner — the same
safe-direction asymmetry as the unicode-`\s` caveat above. The security
invariant `JS_refusals ⊇ bash_refusals` continues to hold.

When this over-refusal triggers, the per-line scan in `scrubBody` finds no
single line that matches, and the refusal message reports `:?` as the
documented line-number fallback (covered by the
`cross-line secret … reports '?' line` test in `scrub.test.ts`).

**Do not "fix" this by switching detection to per-line.** Over-refusal is
the safe direction for a leak gate — biasing the whole-body check toward
refusing more aggressively than the bash side is the design intent, not a
bug to be ironed out.
