// Issue #180 — cursor-sdk honors abort via `run.cancel()`.
//
// The `@cursor/sdk` Run exposes NO `signal` field; `cancel()` is its only
// abort surface. Before this fix, when a vendor stream stalled mid-response
// (the SDK's internal event buffer never closes), `for await (run.stream())`
// and `await run.wait()` blocked forever — even after the runner's 15m
// `DF_CRITIC_TIMEOUT_MS` abort fired — so the critic's `review()` promise
// never settled and the runner's `Promise.all` hung to the 20m job clamp.
//
// The fix bridges `options.signal` → `run.cancel()`: aborting the signal
// cancels the run, which closes the event buffer, terminates the stalled
// `for await`, and unblocks `wait()`. This test mocks a `Run` whose
// `stream()` hangs (never yields) and whose `wait()` hangs, with a `cancel()`
// spy that releases BOTH; it then aborts the signal and asserts `cancel()` is
// called and the attempt settles (so `review()` resolves instead of hanging).

import { afterEach, describe, expect, test, vi } from "vitest";
import type { CriticConfig, ReviewPacket } from "@momentiq/dark-factory-schemas";

// `vi.mock` is hoisted above imports, so the `cancel` spy + the handshake
// deferreds must be created via `vi.hoisted` to be visible inside the
// factory. A single deferred "gate" promise models the SDK's internal event
// buffer: `cancel()` resolves it, which both ends the stream iterator and
// unblocks `wait()`. A second "entered" deferred is the handshake: the mock
// stream resolves it on the FIRST `next()` call, so the test can await the
// adapter actually being parked in the gate before it aborts — deterministic,
// no wall-clock timing.
const { cancelSpy, openGate, gate, entered, markEntered } = vi.hoisted(() => {
  let resolveGate!: () => void;
  const gate = new Promise<void>((r) => {
    resolveGate = r;
  });
  let resolveEntered!: () => void;
  const entered = new Promise<void>((r) => {
    resolveEntered = r;
  });
  return {
    cancelSpy: vi.fn(() => resolveGate()),
    openGate: () => resolveGate(),
    gate,
    entered,
    markEntered: resolveEntered,
  };
});

// The mock Run: a hanging stream + hanging wait, both released by `cancel()`.
// The factory closes over the hoisted deferreds directly.
vi.mock("@cursor/sdk", () => {
  class Agent {
    static async create(): Promise<unknown> {
      return new Agent();
    }
    id = "agent-test";
    model = { id: "m" };
    async send(): Promise<unknown> {
      return {
        id: "run-test",
        // The stream blocks on the shared gate, then ends (done:true) when
        // `cancel()` resolves the gate. It NEVER yields a value — modeling a
        // stalled vendor stream that emitted nothing before wedging. The
        // first `next()` call signals `entered` so the test knows the adapter
        // is parked in the gate (deterministic handshake, no wall-clock).
        stream(): AsyncIterable<unknown> {
          return {
            [Symbol.asyncIterator](): AsyncIterator<unknown> {
              return {
                async next(): Promise<IteratorResult<unknown>> {
                  markEntered();
                  await gate;
                  return { value: undefined, done: true };
                },
              };
            },
          };
        },
        // `wait()` blocks on the same gate, then resolves to a cancelled
        // status — `checkRunFinished` treats non-"finished" as an error, so
        // the attempt settles via the catch path.
        async wait(): Promise<unknown> {
          await gate;
          return { status: "cancelled" };
        },
        cancel: cancelSpy,
      };
    }
    async [Symbol.asyncDispose](): Promise<void> {}
  }
  return { Agent };
});

// Imported AFTER the mock is declared (the mock is hoisted above this anyway).
const { CursorSdkAdapter } = await import("../src/adapters/cursor-sdk.js");

const PACKET: ReviewPacket = {
  repoRoot: "/tmp/repo",
  branch: "main",
  commit: {
    sha: "abcdef0123456789abcdef0123456789abcdef01",
    parent: "0000000000000000000000000000000000000000",
    author: "test",
    email: "test@example.com",
    subject: "test commit",
    body: "",
    timestamp: "2026-06-01T00:00:00Z",
  },
  range: "0000..abcd",
  diffHash: "deadbeef",
  stat: "1 file changed",
  diff: "+ added line\n",
  diffTruncated: false,
  changedFiles: [],
  guidanceFiles: [],
  promptFragments: [],
  validation: {
    requiredQualityGates: [],
    optionalQualityGates: [],
    evidence: [],
    missing: [],
    stale: false,
  },
};

const CRITIC: CriticConfig = {
  id: "cursor",
  name: "Cursor Critic",
  adapter: "cursor-sdk",
  required: false,
  runtime: "local",
  model: { id: "m", params: [] },
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("cursor-sdk — abort terminates a stalled run via run.cancel() (issue #180)", () => {
  test("aborting the signal calls run.cancel() and the review settles instead of hanging", async () => {
    // Pass an explicit apiKey so attemptReview reaches `send()` (a missing
    // key short-circuits to permanent_failure before the mock is touched).
    const adapter = new CursorSdkAdapter({ apiKey: "test-key" });
    const controller = new AbortController();

    // Kick off the review. Attempt 0 is in-flight: the retry loop's loop-top
    // `if (signal.aborted) break` already ran (signal not yet aborted), so
    // the adapter runs `Agent.create()` → `send()` → registers the abort
    // listener → enters the stream gate.
    const reviewPromise = adapter.review(PACKET, CRITIC, {
      blockingSeverities: ["blocker", "high"],
      signal: controller.signal,
    });

    // Deterministic handshake: wait until the mock stream's first `next()`
    // signals it has parked in the gate, so the adapter has definitely
    // registered its abort listener and is blocked. THEN abort — this fires
    // `onAbort()` → `run.cancel()`, which releases the gate.
    await entered;
    controller.abort();

    // The review now SETTLES (it would hang forever without the fix). The
    // result is a structured error (the aborted/cancelled run surfaces a
    // failure; under abort the retry loop exhausts to an error result).
    const result = await reviewPromise;

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("error");
    expect(result.criticId).toBe("cursor");

    // Defensive: ensure the gate is released even if an assertion path above
    // changed (so the test process never leaks a hung promise).
    openGate();
  });
});
