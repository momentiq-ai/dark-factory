/**
 * Secret-shape scrubber for handoff bodies and free-form strings (Cycle 12.2).
 *
 * SoT (single source of truth): the bash ERE below is byte-identical to the
 * `SECRET_PATTERNS='...'` assignment at line 124 of
 * `momentiq-ai/dark-factory-platform`'s
 * `.claude/skills/handoff/scripts/lib.sh`. The cross-repo equivalence is
 * locked down by `tests/handoff/scrub.test.ts` against the vendored fixture
 * at `tests/handoff/fixtures/secret-patterns.bash-ere`. See that fixture's
 * `.PROVENANCE.md` for the re-vendor recipe.
 *
 * The bash gate uses `grep -Ei "$SECRET_PATTERNS"` for detection and
 * `grep -nEi "$SECRET_PATTERNS"` for line numbering. We mirror that idiom
 * here: detection is computed independently from line numbering so that a
 * formatting hiccup in the line-number list can never cause a MISSED secret.
 *
 * Refusal contract (v2-tightened): refusal text NEVER echoes the matched
 * substring — line numbers + bodyfile path only. (The leaked-then-edited
 * secret is still readable in an issue body's edit history, so re-printing
 * it to terminal/scrollback/CI logs would amplify the leak. See SKILL.md
 * § "Security rule".)
 */

/**
 * The bash ERE that DFP's `scrub_secrets()` uses, vendored verbatim.
 *
 * Written with `String.raw` so the four literal backslash-escapes
 * (`\.aws/credentials`, `\.codex/auth\.json`, `\.docker/config\.json`, etc.)
 * survive TypeScript string parsing and stay byte-identical to the fixture
 * at `tests/handoff/fixtures/secret-patterns.bash-ere`.
 *
 * The ERE contains no backticks and no `${...}` interpolation, so the raw
 * template literal is safe.
 */
export const SECRET_PATTERNS_BASH_ERE = String.raw`[A-Za-z0-9_]*(api[_-]?key|secret|token|passwd|password|access[_-]?key|private[_-]?key)[A-Za-z0-9_]*[[:space:]]*[:=][[:space:]]*[^[:space:]]|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|sk-(ant-|proj-)?[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{16,}|[a-z][a-z0-9+.-]*://[^[:space:]/:@]+:[^[:space:]/@]+@|\.(aws/credentials|kube/config|ssh/id_[a-z0-9]+|codex/auth\.json|config/gcloud|docker/config\.json|netrc|npmrc|pgpass|dockercfg)|-----BEGIN`;

/**
 * Live matcher derived from `SECRET_PATTERNS_BASH_ERE` by translating the
 * four POSIX bracket-class expressions JS RegExp does not understand:
 *
 *   [[:space:]]      → \s
 *   [^[:space:]]     → \S
 *   [^[:space:]/:@]  → [^\s/:@]
 *   [^[:space:]/@]   → [^\s/@]
 *
 * The order matters: longest pattern first, so that
 * `[^[:space:]/:@]` is replaced before `[^[:space:]]` or `[[:space:]]`
 * (substring-overlap would otherwise corrupt the longer class).
 *
 * A naive `new RegExp(SECRET_PATTERNS_BASH_ERE, "i")` SILENTLY miscompiles
 * `[[:space:]]` to the character class `[ : s p a c e ]` + a stray `]`, so
 * env-var (`MY_API_KEY=value`) and connection-string
 * (`postgres://user:pw@host`) patterns under-match while AKIA / sk- / PEM
 * still pass. Tests exercise every POSIX-path category so a regression in
 * this translation fails visibly.
 *
 * The `i` flag mirrors `grep -Ei` in the bash gate (so `DB_PASSWORD`,
 * `MY_API_KEY` etc. match the lowercase-anchored alternatives).
 * Deliberately NO `g` flag: a stateful `lastIndex` would break per-line
 * `.test()` calls in `scrubBody`.
 *
 * JS `\s` is a superset of POSIX `[[:space:]]` (Unicode vs ASCII-only). For
 * a secret-scrubber this is safe asymmetry: over-matching whitespace can
 * only make us refuse MORE aggressively than the bash side, never less.
 */
export const SECRET_PATTERNS_JS = new RegExp(
  SECRET_PATTERNS_BASH_ERE
    .replaceAll("[^[:space:]/:@]", "[^\\s/:@]")
    .replaceAll("[^[:space:]/@]", "[^\\s/@]")
    .replaceAll("[^[:space:]]", "\\S")
    .replaceAll("[[:space:]]", "\\s"),
  "i",
);

export type ScrubResult = { ok: true } | { ok: false; refusal: string };

/**
 * Scrub a handoff body for secret-shaped content.
 *
 * Returns `{ ok: true }` if clean. Otherwise returns
 * `{ ok: false, refusal: "..." }` whose message names the bodyfile path and
 * the comma-separated 1-indexed line numbers of the offending lines.
 *
 * The refusal message NEVER includes the matched substring (see file-level
 * docs and SKILL.md § "Security rule").
 *
 * Mirrors the bash idiom: detection (boolean) is the authority, line
 * numbering is best-effort formatting. If line numbering ever comes up
 * empty after detection succeeded, the message still refuses with `?`.
 */
export function scrubBody(body: string, bodyfile: string): ScrubResult {
  // Detection authority — compute independently of line formatting so a
  // formatting hiccup can never cause a MISSED secret.
  if (!SECRET_PATTERNS_JS.test(body)) {
    return { ok: true };
  }
  // Best-effort line numbering. Splitting on \n is line-equivalent to
  // bash's `grep -n` per-line walk for typical UTF-8 text.
  const lines = body.split("\n");
  const offendingLineNumbers: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (SECRET_PATTERNS_JS.test(lines[i]!)) {
      offendingLineNumbers.push(i + 1);
    }
  }
  const lineList = offendingLineNumbers.length > 0
    ? offendingLineNumbers.join(",")
    : "?";
  return {
    ok: false,
    refusal: `aborted: secret-shaped content in ${bodyfile}:${lineList}; rephrase as setup steps (no value echo — see SKILL.md § Security rule).`,
  };
}

/**
 * Scrub a free-form string (PR title, CLI arg, etc.) for secret-shaped
 * content. Used for the inputs that don't have a "file with lines" shape.
 *
 * Returns `{ ok: true }` if clean. Otherwise returns
 * `{ ok: false, refusal: "..." }` whose message names the human-readable
 * source label (e.g. "PR #303 title") but NEVER the matched substring.
 *
 * The refusal points the operator at the source-of-truth edit
 * (`gh pr edit <N> --title …`) so the upstream is fixed instead of
 * laundering the leak into the handoff body.
 */
export function scrubString(s: string, label: string): ScrubResult {
  if (!SECRET_PATTERNS_JS.test(s)) {
    return { ok: true };
  }
  return {
    ok: false,
    refusal: `aborted: secret-shaped content in ${label} — rephrase the source (e.g. \`gh pr edit <N> --title …\`) so the handoff body stays scrubable. (No value echo — see SKILL.md § Security rule.)`,
  };
}
