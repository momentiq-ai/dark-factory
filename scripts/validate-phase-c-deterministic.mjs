#!/usr/bin/env node
// scripts/validate-phase-c-deterministic.mjs
//
// Empirical validation of cycle 15 Phase C's deterministic seeders against
// the real sage3c clone — metrics 2-5 only (metric 1 requires the LLM call).
//
// Standalone helper, NOT a test file. Reads dist/onboard/* directly so we
// can validate the seeder output without ANTHROPIC_API_KEY in the env.
// Run from the dark-factory clone root after `npm run build --workspace
// packages/cli`.
//
// ## Why this exists alongside the vitest harness (intentional duplication)
//
// `packages/cli/tests/onboard/sage3c-reproduction.test.ts` is the canonical
// end-to-end harness — it spawns the CLI binary, runs real Phase B
// generatePlan (LLM call), and asserts all 5 metrics. That harness is
// `describe.skipIf(!ANTHROPIC_API_KEY)` because the subprocess fails
// without the LLM key.
//
// The skip masks MORE than metric 1: the harness's beforeAll (clone,
// scrub, subprocess invoke, JSON parse) never runs either, so deterministic
// metrics 2-5 — the ones Phase C owns — are also unverified in any env
// without an Anthropic key (CI, dev workstations without Doppler ANTHROPIC,
// the W3 critic sandbox, etc.).
//
// This script bypasses subprocess + LLM by calling `analyze` + `runSeeders`
// directly. The assertion logic intentionally duplicates the harness's
// metric-2–5 contract so deterministic verification can run anywhere.
// Drift is bounded by review discipline: any change to the harness's
// deterministic-metric assertions should be mirrored here in the same PR.
// See `feedback_deterministic_validation_harness.md` in agent memory for
// the underlying rationale.
//
// Usage:
//   node scripts/validate-phase-c-deterministic.mjs <path-to-cleaned-sage3c-clone>
//
// Exit codes: 0 = all 4 deterministic metrics pass, 1 = at least one fails.

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DIST = resolve(ROOT, "packages", "cli", "dist", "onboard");

const target = process.argv[2];
if (!target) {
  console.error("usage: validate-phase-c-deterministic.mjs <cleaned-sage3c-clone>");
  process.exit(2);
}

const { analyze } = await import(resolve(DIST, "analyze.js"));
const { runSeeders, ALL_SEEDERS_DEFAULT } = await import(resolve(DIST, "seeders", "index.js"));

console.error(`[validate] analyzing ${target}...`);
const analysis = await analyze(target);
console.error(`[validate] decisions: ${analysis.decisions.length}, services: ${analysis.services.length}, workflows: ${analysis.ci.workflows.length}`);

console.error(`[validate] running ALL_SEEDERS_DEFAULT...`);
const seederFiles = await runSeeders(
  { analysis, existingAdrs: [], now: new Date("2026-06-05"), profile: "local" },
  ALL_SEEDERS_DEFAULT,
);
console.error(`[validate] seeders emitted ${seederFiles.length} FilePlan entries`);

const failures = [];

// Metric 2: ≥ 3 ADRs with Context + Decision + Consequences + citations.
const adrs = seederFiles.filter(
  (f) => /^docs\/ADR\/\d{4}-\d{2}-.*\.md$/.test(f.path) && f.action === "emit",
);
console.error(`[metric 2] ADRs emitted: ${adrs.length}`);
if (adrs.length < 3) {
  failures.push(`metric 2: expected ≥3 ADRs, got ${adrs.length}`);
} else {
  for (const adr of adrs) {
    const body = adr.tailored_content;
    if (!/^## Context\s*$/m.test(body)) failures.push(`metric 2: ${adr.path} missing ## Context`);
    if (!/^## Decision\s*$/m.test(body)) failures.push(`metric 2: ${adr.path} missing ## Decision`);
    if (!/^## Consequences\s*$/m.test(body)) failures.push(`metric 2: ${adr.path} missing ## Consequences`);
    if (!/`[A-Za-z0-9_./-]+\.(md|yml|json|ts|tsx|js|py|toml|lock)`/.test(body)) {
      failures.push(`metric 2: ${adr.path} no citation`);
    }
  }
}

// Metric 3: cycle1 bootstrap doc.
const c1 = seederFiles.find(
  (f) => /^docs\/roadmap\/cycles\/cycle1-.*\.md$/.test(f.path) && f.action === "emit",
);
console.error(`[metric 3] cycle1 bootstrap path: ${c1?.path ?? "(missing)"}`);
if (!c1) {
  failures.push(`metric 3: no cycle1 bootstrap doc emitted`);
} else {
  const body = c1.tailored_content;
  if (!/^## Stack\s*$/m.test(body)) failures.push(`metric 3: cycle1 missing ## Stack`);
  if (!/^## Services\s*$/m.test(body)) failures.push(`metric 3: cycle1 missing ## Services`);
  if (!/^## Deploy story\s*$/m.test(body)) failures.push(`metric 3: cycle1 missing ## Deploy story`);
  if (/\{[a-z_]+\}/.test(body)) failures.push(`metric 3: cycle1 has unreplaced {token} placeholders`);
}

// Metric 4: ≥ 1 runbook with verbatim CI run: line.
const runbooks = seederFiles.filter(
  (f) => /^docs\/runbooks\/RUNBOOK-.*\.md$/.test(f.path) && f.action === "emit",
);
console.error(`[metric 4] runbooks emitted: ${runbooks.length}`);
if (runbooks.length === 0) {
  failures.push(`metric 4: no runbooks emitted`);
} else {
  // Read sage3c workflows + check for verbatim line in any runbook.
  const { readdir } = await import("node:fs/promises");
  const workflowsDir = resolve(target, ".github", "workflows");
  let runLines = [];
  try {
    const entries = await readdir(workflowsDir);
    for (const f of entries) {
      if (!f.endsWith(".yml") && !f.endsWith(".yaml")) continue;
      const body = await readFile(resolve(workflowsDir, f), "utf8");
      for (const line of body.split(/\r?\n/)) {
        const m = /^\s*-\s*run:\s*(.+)$/.exec(line) ?? /^\s*run:\s*(.+)$/.exec(line);
        if (m) runLines.push(m[1].trim());
      }
    }
  } catch (e) {
    console.error(`[metric 4] could not read workflows dir: ${e.message}`);
  }
  runLines = runLines.filter((c) => c.length > 10);
  console.error(`[metric 4] candidate verbatim CI lines: ${runLines.length}`);
  const haystacks = runbooks.map((r) => r.tailored_content);
  const found = runLines.some((cmd) => haystacks.some((h) => h.includes(cmd)));
  if (!found) failures.push(`metric 4: no runbook contains a verbatim CI run: line`);
}

// Metric 5: .agent-review/config.json deep-sort-equals local canonical.
const cfg = seederFiles.find((f) => f.path === ".agent-review/config.json");
console.error(`[metric 5] config emit found: ${!!cfg}`);
if (!cfg) {
  failures.push(`metric 5: .agent-review/config.json not emitted`);
} else {
  const actual = JSON.parse(cfg.tailored_content);
  const canonicalPath = resolve(
    ROOT,
    "packages",
    "cli",
    "src",
    "onboard",
    "seeders",
    "agent-review-config",
    "local.canonical.json",
  );
  const expected = JSON.parse(await readFile(canonicalPath, "utf8"));
  const deepSort = (v) => {
    if (Array.isArray(v)) return v.map(deepSort);
    if (v && typeof v === "object") {
      const sorted = {};
      for (const k of Object.keys(v).sort()) sorted[k] = deepSort(v[k]);
      return sorted;
    }
    return v;
  };
  if (JSON.stringify(deepSort(actual)) !== JSON.stringify(deepSort(expected))) {
    failures.push(`metric 5: config deep-sort-not-equal to local canonical`);
  }
}

if (failures.length > 0) {
  console.error("");
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.error("");
console.error("ALL 4 DETERMINISTIC METRICS PASS (metric 1 is LLM-dependent, gated on ANTHROPIC_API_KEY)");
process.exit(0);
