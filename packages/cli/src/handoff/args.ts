// packages/cli/src/handoff/args.ts
//
// Argument validators. PORT FROM dark-factory-platform lib.sh@a6f711b:
//   require_issue_number  (lines 46-53)
//   require_safe_args     (lines 61-75)
//
// requireSafeArgs is defense-in-depth: in the TS CLI, real argv kills the
// shell-metacharacter injection vector that the bash .md/$ARGUMENTS surface
// was defending against (the operator's payload reaches process.argv as a
// string and cannot re-enter a shell). We keep the allow-list anyway because:
//   (a) MCP tool callers might pass any string, and rejecting metacharacters
//       early is cheap defense-in-depth, and
//   (b) it preserves byte-equivalent error messages with the bash impl for
//       the ~6 ported payload-rejection tests, simplifying the case-map.

import { HandoffError } from "./ports.js";

/**
 * Validate a positive-integer issue number string → number. Empty/undefined
 * returns undefined (the "no issue arg" path several verbs allow).
 *
 * Mirrors bash require_issue_number (lib.sh:46-53):
 *   case "${1:-}" in
 *     "")        return 0 ;;                                          # empty allowed
 *     0|0*)      die "issue must be a positive integer (got: '$1')." ;;
 *     *[!0-9]*)  die "issue must be a positive integer (got: '$1')." ;;
 *     *)         return 0 ;;
 *   esac
 *
 * Note: the bash impl also rejects leading-whitespace ("42 " or " 42") because
 * `case` does literal matching. We match that by rejecting any string that is
 * not solely digits.
 */
export function requireIssueNumber(input: string | undefined): number | undefined {
  if (input === undefined || input === "") return undefined;
  // Reject 0 (case: "0") and leading-zero (case: "0*").
  if (input === "0" || /^0/.test(input)) {
    throw new HandoffError(`issue must be a positive integer (got: '${input}').`);
  }
  // Reject anything other than bare ASCII digits.
  if (!/^[0-9]+$/.test(input)) {
    throw new HandoffError(`issue must be a positive integer (got: '${input}').`);
  }
  return Number(input);
}

/**
 * Allow-list per bash require_safe_args (lib.sh:61-75). Excludes shell
 * metacharacters (`;$()'`|&><!*[]`) while permitting URL-safe chars (?=%+~)
 * for --link URLs like https://github.com/o/r/pull/N?tab=files.
 *
 * Per the bash pattern `*[!a-zA-Z0-9_/#:.,@?=%+~\ -]*`, the allowed set is:
 *   alphanumeric (a-zA-Z0-9)
 *   _ / # : . , @ ? = % + ~
 *   space
 *   - (placed at end to avoid range interpretation)
 *
 * Throws HandoffError with the same message wording as bash on a disallowed
 * character.
 */
const SAFE_ARG_PATTERN = /^[a-zA-Z0-9_/#:.,@?=%+~ \-]*$/;

export function requireSafeArgs(args: readonly string[]): void {
  for (const arg of args) {
    if (!SAFE_ARG_PATTERN.test(arg)) {
      throw new HandoffError(
        "argument contains disallowed characters: refusing for safety " +
          "(allowed: alphanumeric / # : . , @ - _ ? = % + ~ space).",
      );
    }
  }
}
