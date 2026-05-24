// Service #8 boundary test — verifies the audit-trail helpers (the
// `_runs.ndjson` sink + read/summarize utilities) are importable via
// the `evidence/` boundary after the Phase D refactor that moved
// `telemetry.ts` into `evidence/audit-trail.ts`.
//
// Earlier rounds of the policy-override tests cover the runner-side
// MemoryTelemetrySink end-to-end; this test focuses on the read +
// analyze + bypass-event-extraction surface that `df audit stats`
// depends on.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TelemetryEvent } from "@momentiq/dark-factory-schemas";

import {
  FileTelemetrySink,
  MemoryTelemetrySink,
  computeCriticAgreement,
  computeQuorumStats,
  readTelemetryEvents,
  summarizeTelemetry,
} from "../../src/evidence/audit-trail.js";

// Same symbols must be reachable via the barrel index so consumers
// that `import { ... } from "@momentiq/dark-factory-cli/evidence"`
// keep working after the rename.
import {
  FileTelemetrySink as BarrelFileSink,
  MemoryTelemetrySink as BarrelMemorySink,
  readTelemetryEvents as barrelRead,
  summarizeTelemetry as barrelSummarize,
} from "../../src/evidence/index.js";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "df-audit-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("audit-trail boundary — Phase D refactor", () => {
  it("MemoryTelemetrySink records events in order", () => {
    const sink = new MemoryTelemetrySink();
    sink.emit({ event: "critic_run_started", criticId: "cursor" } as TelemetryEvent);
    sink.emit({ event: "gate_passed" } as TelemetryEvent);
    expect(sink.events).toHaveLength(2);
    expect(sink.events[0]?.event).toBe("critic_run_started");
    expect(sink.events[1]?.event).toBe("gate_passed");
  });

  it("FileTelemetrySink appends newline-delimited JSON", () => {
    const path = join(scratch, "_runs.ndjson");
    const sink = new FileTelemetrySink(path);
    sink.emit({ event: "critic_run_started", criticId: "cursor" } as TelemetryEvent);
    sink.emit({ event: "gate_bypassed", bypassReason: "test" } as TelemetryEvent);
    const events = readTelemetryEvents(path);
    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe("critic_run_started");
    expect(events[1]?.event).toBe("gate_bypassed");
  });

  it("readTelemetryEvents returns [] for a non-existent file", () => {
    expect(readTelemetryEvents(join(scratch, "missing.ndjson"))).toEqual([]);
  });

  it("readTelemetryEvents skips corrupt lines", () => {
    const path = join(scratch, "corrupt.ndjson");
    writeFileSync(
      path,
      '{"event":"gate_passed"}\n' +
        "not-json\n" +
        '{"event":"gate_bypassed","bypassReason":"x"}\n',
      "utf8",
    );
    const events = readTelemetryEvents(path);
    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe("gate_passed");
    expect(events[1]?.event).toBe("gate_bypassed");
  });

  it("summarizeTelemetry counts passes / blocks / bypasses", () => {
    const stats = summarizeTelemetry([
      { event: "gate_passed" } as TelemetryEvent,
      { event: "gate_passed" } as TelemetryEvent,
      { event: "gate_blocked" } as TelemetryEvent,
      { event: "gate_bypassed", bypassReason: "emergency" } as TelemetryEvent,
    ]);
    expect(stats.passes).toBe(2);
    expect(stats.blocks).toBe(1);
    expect(stats.bypasses).toBe(1);
  });

  it("summarizeTelemetry surfaces critic-level finish/error counts", () => {
    const events: TelemetryEvent[] = [
      { event: "critic_run_started", criticId: "cursor" } as TelemetryEvent,
      {
        event: "critic_run_finished",
        criticId: "cursor",
        verdict: "APPROVED",
        findingCount: 0,
        blockerCount: 0,
        highCount: 0,
        durationMs: 1000,
      } as TelemetryEvent,
      { event: "critic_run_started", criticId: "codex" } as TelemetryEvent,
      {
        event: "critic_run_finished",
        criticId: "codex",
        verdict: "CHANGES_REQUESTED",
        findingCount: 3,
        blockerCount: 1,
        highCount: 2,
        durationMs: 2000,
      } as TelemetryEvent,
    ];
    const stats = summarizeTelemetry(events);
    expect(stats.totalRuns).toBe(2);
    expect(stats.approvedCount).toBe(1);
    expect(stats.changesRequestedCount).toBe(1);
    expect(stats.byCritic.cursor?.finishes).toBe(1);
    expect(stats.byCritic.codex?.totalBlockers).toBe(1);
    expect(stats.byCritic.codex?.totalHigh).toBe(2);
  });

  it("computeCriticAgreement returns 100% for unanimous verdicts", () => {
    const events: TelemetryEvent[] = [
      {
        event: "critic_run_finished",
        criticId: "cursor",
        commit: "abc",
        verdict: "APPROVED",
      } as TelemetryEvent,
      {
        event: "critic_run_finished",
        criticId: "codex",
        commit: "abc",
        verdict: "APPROVED",
      } as TelemetryEvent,
    ];
    const a = computeCriticAgreement(events);
    expect(a.comparedCommits).toBe(1);
    expect(a.agreedCommits).toBe(1);
    expect(a.disagreementsByPattern).toEqual({});
    expect(a.comparedCriticIds).toEqual(["codex", "cursor"]);
  });

  it("computeCriticAgreement records disagreements with sorted critic ids", () => {
    const events: TelemetryEvent[] = [
      {
        event: "critic_run_finished",
        criticId: "cursor",
        commit: "abc",
        verdict: "APPROVED",
      } as TelemetryEvent,
      {
        event: "critic_run_finished",
        criticId: "codex",
        commit: "abc",
        verdict: "CHANGES_REQUESTED",
      } as TelemetryEvent,
    ];
    const a = computeCriticAgreement(events);
    expect(a.agreedCommits).toBe(0);
    expect(a.disagreementsByPattern["codex:CHANGES_REQUESTED / cursor:APPROVED"]).toBe(1);
  });

  it("computeQuorumStats counts aggregate reasons", () => {
    const events: TelemetryEvent[] = [
      { event: "review_finished", aggregateReason: "majority" } as TelemetryEvent,
      { event: "review_finished", aggregateReason: "majority" } as TelemetryEvent,
      {
        event: "review_finished",
        aggregateReason: "quorum_unmet",
        criticCompletionStates: { cursor: "errored", codex: "completed" },
      } as TelemetryEvent,
    ];
    const q = computeQuorumStats(events);
    expect(q.totalAggregateEvents).toBe(3);
    expect(q.byReason["majority"]).toBe(2);
    expect(q.byReason["quorum_unmet"]).toBe(1);
    expect(q.quorumUnmetByCritic["cursor"]).toBe(1);
    expect(q.quorumUnmetByCritic["codex"]).toBeUndefined();
  });

  it("evidence barrel re-exports the same symbols", () => {
    expect(BarrelFileSink).toBe(FileTelemetrySink);
    expect(BarrelMemorySink).toBe(MemoryTelemetrySink);
    expect(barrelRead).toBe(readTelemetryEvents);
    expect(barrelSummarize).toBe(summarizeTelemetry);
  });
});
