import { test } from "vitest";
import { expect_match, expect_no_match } from "./_assert-shim.js";
import type { ReviewPacket } from "@momentiq/dark-factory-schemas";
import { formatValidation } from "../src/prompt.js";

// formatValidation only reads `packet.validation.{evidence,missing,stale}`,
// so a minimal stub is sufficient to exercise the branch we care about.
function packetWith(validation: {
  evidence: unknown[];
  missing: string[];
  stale: boolean;
}): ReviewPacket {
  return { validation } as unknown as ReviewPacket;
}

// Regression: a consumer repo that runs no critic-side quality gates (empty
// requiredQualityGates + no triggered verification routes => `missing` is
// empty) must NOT be told "No deterministic quality-gate evidence available".
// That phrasing made critics invoke the "cannot decide safely =>
// CHANGES_REQUESTED" path and block clean consumer PRs — the W1->W3 cutover
// failure mode (sage3c #2304). Absence of evidence is only a gap when a gate
// was actually required (`missing.length > 0`).
test("formatValidation: no gates configured (missing empty) is explicitly NOT a blocker", () => {
  const out = formatValidation(packetWith({ evidence: [], missing: [], stale: false }));
  expect_match(out, /not itself a blocker/i);
  expect_no_match(out, /No deterministic quality-gate evidence available/);
});

test("formatValidation: a required gate with no evidence is still flagged as a real gap", () => {
  const out = formatValidation(
    packetWith({ evidence: [], missing: ["make sage-quality-gates-static"], stale: false }),
  );
  expect_match(out, /No deterministic quality-gate evidence available/);
  expect_match(out, /Missing required gates/);
});
