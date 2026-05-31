// packages/cli/tests/handoff/fixtures/stubs/fixed-clock.ts
//
// Deterministic Clock fake — epoch + ymd are constructor-pinned so
// format_age tests can assert exact ages (the bash test stub couldn't
// pin "now", which is why its tests never asserted exact ages).
import type { Clock } from "../../../../src/handoff/ports.js";

export class FixedClock implements Clock {
  constructor(
    private readonly epoch: number,
    private readonly ymd: string,
  ) {}
  nowEpoch(): number {
    return this.epoch;
  }
  todayYmd(): string {
    return this.ymd;
  }
}
