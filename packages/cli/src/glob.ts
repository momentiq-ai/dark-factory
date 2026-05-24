// POSIX-style glob matcher with the subset needed for verification-route
// triggers and TDD classifier globs. Kept dependency-free on purpose:
// pulling in picomatch / minimatch would expand the supply-chain surface
// of a security-sensitive tool that already runs as a git hook. The subset
// here is what the cycle 318.2 config actually uses:
//
//   *        — matches any sequence of characters EXCEPT path separator
//   **       — matches any sequence of characters INCLUDING path separators
//   ?        — matches a single character (not path separator)
//   {a,b,c}  — matches any of the comma-separated alternatives (one level)
//   [abc]    — matches one of a, b, c (character class)
//   /        — matched literally
//
// Match is anchored to the full string (not substring), case-sensitive,
// and uses POSIX path semantics (forward slash). Patterns are compiled to
// a RegExp at call time; cache externally if perf becomes a concern.

export function compileGlob(pattern: string): RegExp {
  let i = 0;
  let body = "";
  while (i < pattern.length) {
    const ch = pattern[i] ?? "";
    if (ch === "*") {
      // Look ahead for `**`.
      if (pattern[i + 1] === "*") {
        // `**/` or `**` at end: match any characters including `/`.
        // Allow `**/` to optionally match zero segments (so `a/**/b` matches `a/b`).
        if (pattern[i + 2] === "/") {
          body += "(?:.*/)?";
          i += 3;
        } else {
          body += ".*";
          i += 2;
        }
      } else {
        // Single `*`: match anything except `/`.
        body += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      body += "[^/]";
      i += 1;
    } else if (ch === "{") {
      // One-level brace expansion: {ts,tsx} → (?:ts|tsx).
      // Nested braces are not supported (no current callers need them).
      const close = pattern.indexOf("}", i + 1);
      if (close === -1) {
        // Unmatched brace — fall through to literal.
        body += "\\{";
        i += 1;
        continue;
      }
      const inner = pattern.slice(i + 1, close);
      const alts = inner.split(",").map((s) => escapeRegex(s));
      body += `(?:${alts.join("|")})`;
      i = close + 1;
    } else if (ch === "[") {
      // Character class; escape `/` as `\/` inside the regex but keep
      // the class otherwise verbatim. Note `[!...]` (POSIX negation) is
      // converted to `[^...]`.
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        body += "\\[";
        i += 1;
        continue;
      }
      let inner = pattern.slice(i + 1, close);
      if (inner.startsWith("!")) {
        inner = `^${inner.slice(1)}`;
      }
      body += `[${inner}]`;
      i = close + 1;
    } else {
      body += escapeRegex(ch);
      i += 1;
    }
  }
  return new RegExp(`^${body}$`);
}

const REGEX_ESCAPE = /[.+^$|()\\\\]/g;

function escapeRegex(s: string): string {
  return s.replace(REGEX_ESCAPE, "\\$&");
}

export function matchGlob(path: string, pattern: string): boolean {
  return compileGlob(pattern).test(path);
}

export function matchAnyGlob(path: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (matchGlob(path, p)) return true;
  }
  return false;
}
