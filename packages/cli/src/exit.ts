// CLI process-exit finalization — issue #167.
//
// The `df` CLI is a short-lived process that loads several vendor critic
// SDKs (cursor / codex / gemini / grok). Some of those SDKs leave a libuv
// handle open after their work is done — an undrained keep-alive socket,
// a sqlite3 database handle (pulled in transitively by @cursor/sdk), an
// internal flush timer. The CLI itself cleans up everything it owns
// (`runReview` clears its internal-deadline timer, releases the commit
// lock, and uninstalls its signal guard in a `finally`), but it cannot
// reach into a third-party SDK to close a handle that SDK forgot.
//
// The original entrypoint set `process.exitCode` and returned, trusting
// the event loop to drain on its own. One leaked dependency handle defeats
// that: the loop never empties, so `node dist/cli.js critic` runs to
// completion (verdict printed, artifact written) and then hangs. In CI
// that hang is invisible until the GitHub Actions `timeout-minutes` clamp
// force-kills the job ~12 minutes later and reports `cancelled` — the
// failure mode tracked in #167 (run 27080325829: work finished at 8m,
// process killed at 20m as an orphan `node` process).
//
// `finalizeExit` makes the CLI own its exit instead of delegating to the
// event loop: it records the exit code and arms an **unref'd** backstop
// timer that force-exits with that same code. Because the timer is
// `unref`'d, it never keeps a healthy process alive — a clean loop drains
// and exits naturally well before the grace window, and the discarded
// timer changes nothing. It only fires when something *else* is keeping
// the loop alive past the grace window, i.e. exactly the leaked-handle
// case, where force-exiting with the command's code is strictly better
// than waiting for the runner to kill us.
//
// This lives ONLY in the CLI entrypoint path (`isInvokedAsMain()` in
// cli.ts). Library embedders — most importantly the hosted W3 worker,
// which calls `runReview()` in a long-lived process and owns its own
// lifecycle — import the module without tripping the entrypoint guard, so
// their shutdown semantics are untouched.

/**
 * Grace period, in milliseconds, between a command resolving and the
 * force-exit backstop firing. Sized generously: it costs nothing on a
 * healthy run (the process exits naturally first and the unref'd timer is
 * discarded), and on a wedged run it leaves ample time for buffered stdout
 * — the verdict block — to flush to a pipe before the hard exit. Strictly
 * less than any reasonable CI `timeout-minutes` so the CLI always wins the
 * race against the job clamp.
 */
export const DEFAULT_EXIT_GRACE_MS = 1000;

export interface FinalizeExitOptions {
  /** Override the grace window (primarily for tests). */
  graceMs?: number;
  /**
   * Injectable exit function (tests pass a spy). Defaults to
   * `process.exit`, which terminates the process with the given code.
   */
  exit?: (code: number) => void;
}

/**
 * Finalize the `df` CLI's exit: record `code` as the process exit code and
 * arm an unref'd force-exit backstop so a leaked dependency handle can't
 * hang the process past the CI job timeout (#167). Returns the backstop
 * timer so the caller (or a test) can clear it.
 */
export function finalizeExit(code: number, options: FinalizeExitOptions = {}): NodeJS.Timeout {
  const graceMs = options.graceMs ?? DEFAULT_EXIT_GRACE_MS;
  const exit = options.exit ?? ((c: number) => process.exit(c));

  // Set the natural exit code first: if the loop drains before the grace
  // window, the process exits cleanly with this code and the backstop is
  // never needed.
  process.exitCode = code;

  const timer = setTimeout(() => exit(code), graceMs);
  // Do not let the backstop itself keep the process alive. An unref'd
  // timer is skipped when it is the only thing left on the loop (clean
  // shutdown) but still fires when another handle is holding the loop open
  // (the leaked-handle hang we are guarding against).
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}
