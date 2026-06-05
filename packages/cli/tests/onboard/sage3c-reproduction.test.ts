// packages/cli/tests/onboard/sage3c-reproduction.spec.ts
//
// Cycle 15 Phase C — Task 5 — the headline ≥ 90% acceptance harness.
//
// What this test does:
//   1. clone `momentiq-ai/sage3c` at the pinned sha into a cache dir
//   2. surgically remove the agent-context set + .agent-review/config.json
//   3. run `df onboard --dry-run --json <workdir>` against the cleaned clone
//   4. assert 5 structural metrics (D3 rows 1-5) against the merged plan
//
// Metric 1 (CLAUDE.md heading retention ≥ 90%) requires a real LLM call —
// the harness invokes the CLI as a subprocess, NOT a mocked generatePlan.
// The whole suite is `describe.skipIf(!ANTHROPIC_API_KEY)` so the test can
// live on main while LLM creds are absent in some environments (CI runs
// with the secret, local dev pre-onboard runs without). When skipped, the
// vitest output makes the gap loud.
//
// Pin policy: SAGE3C_PINNED_SHA is a constant captured at commit time via
// `gh api repos/momentiq-ai/sage3c/commits/main --jq .sha`. The cycle 15
// risk § "Sage3c reproduction test brittleness" tracks the deliberate-bump
// policy.

import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, cp, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import type { ScaffoldPlan } from "../../src/onboard/scaffold-schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ex = promisify(execFile);

// Pinned sage3c sha. Captured 2026-06-05 via:
//   gh api repos/momentiq-ai/sage3c/commits/main --jq .sha
const SAGE3C_PINNED_SHA = "a8180e7ee521e9d56f2cb90d82cecb4f59fa1d28";

const SAGE3C_CACHE_BASE = join(homedir(), ".df", "cache", "sage3c");
const SAGE3C_CACHE_DIR = join(SAGE3C_CACHE_BASE, SAGE3C_PINNED_SHA);

const CLI_BIN = resolve(__dirname, "..", "..", "dist", "cli.js");

async function ensureSageClone(): Promise<void> {
  if (existsSync(join(SAGE3C_CACHE_DIR, ".git"))) return;
  await mkdir(SAGE3C_CACHE_BASE, { recursive: true });
  await rm(SAGE3C_CACHE_DIR, { recursive: true, force: true });
  await ex("git", [
    "clone",
    "--depth",
    "50",
    "https://github.com/momentiq-ai/sage3c.git",
    SAGE3C_CACHE_DIR,
  ]);
  // Best-effort fetch + checkout. If the pinned sha is older than the
  // shallow-clone depth, deepen.
  try {
    await ex("git", ["fetch", "--depth", "200", "origin", SAGE3C_PINNED_SHA], {
      cwd: SAGE3C_CACHE_DIR,
    });
  } catch {
    // sha may already be in the shallow set
  }
  await ex("git", ["checkout", SAGE3C_PINNED_SHA], { cwd: SAGE3C_CACHE_DIR });
}

interface OnboardJsonOutput {
  plan: ScaffoldPlan;
}

async function runOnboardDryRun(workdir: string): Promise<OnboardJsonOutput> {
  const { stdout } = await ex(
    "node",
    [CLI_BIN, "onboard", "--dry-run", "--json", workdir],
    { maxBuffer: 50 * 1024 * 1024 },
  );
  // CLI's --dry-run --json path emits the ScaffoldPlan as the top-level
  // JSON (see commands/onboard.ts — `io.stdout(JSON.stringify(plan) + "\n")`),
  // not wrapped under `{plan: ...}`. The harness normalizes to the
  // `{plan}` shape so the metric assertions read uniformly.
  const plan = JSON.parse(stdout) as ScaffoldPlan;
  return { plan };
}

function extractHeadings(markdown: string): string[] {
  // H1 + H2 only. Strip leading `#`s, trim, normalize whitespace, lowercase.
  const out: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^(#{1,2})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const text = m[2]!.replace(/\s+/g, " ").trim().toLowerCase();
    out.push(text);
  }
  return out;
}

function headingRetention(actual: readonly string[], expected: readonly string[]): number {
  if (expected.length === 0) return 1;
  const expectedSet = new Set(expected);
  const intersected = actual.filter((h) => expectedSet.has(h));
  return intersected.length / expected.length;
}

// Helper — collect verbatim `run:` lines from every workflow under the given dir.
async function collectRunLines(workflowsDir: string): Promise<string[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(workflowsDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const f of entries) {
    if (!f.endsWith(".yml") && !f.endsWith(".yaml")) continue;
    const body = await readFile(join(workflowsDir, f), "utf8");
    for (const line of body.split(/\r?\n/)) {
      const m = /^\s*-\s*run:\s*(.+)$/.exec(line);
      if (m) out.push(m[1]!.trim());
      const single = /^\s*run:\s*(.+)$/.exec(line);
      if (single) out.push(single[1]!.trim());
    }
  }
  // Filter out trivial / one-token commands that would trivially match.
  return out.filter((c) => c.length > 10);
}

// Deep-sort helper for nested-JSON comparison without false-failing on
// key-order drift. Matches the agent-review-config unit-test helper.
function deepSort(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(deepSort);
  if (v && typeof v === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[k] = deepSort((v as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return v;
}

// LLM-creds gating: the harness invokes the CLI binary as a subprocess; the
// dry-run + non-analysis-only path requires ANTHROPIC_API_KEY (or --api-key)
// because Phase B's generatePlan runs first. Without creds the suite would
// fail at beforeAll on the CLI subprocess. The skip is loud — vitest reports
// the suite as skipped, so the absence is visible.
const hasAnthropicKey = !!(process.env["ANTHROPIC_API_KEY"]?.trim());

describe.skipIf(!hasAnthropicKey)(
  "sage3c reproduction harness (cycle 15 exit criterion — requires ANTHROPIC_API_KEY)",
  () => {
    let cleanedClone: string;
    let originalClaudeMd: string;
    let originalCiCommands: string[];
    let plan: ScaffoldPlan;

    beforeAll(async () => {
      await ensureSageClone();
      originalClaudeMd = await readFile(join(SAGE3C_CACHE_DIR, "CLAUDE.md"), "utf8");

      originalCiCommands = await collectRunLines(
        join(SAGE3C_CACHE_DIR, ".github", "workflows"),
      );

      // Stage a CLEAN clone (the cached one stays untouched for re-runs).
      cleanedClone = join(SAGE3C_CACHE_BASE, "_cleaned_for_test");
      await rm(cleanedClone, { recursive: true, force: true });
      await cp(SAGE3C_CACHE_DIR, cleanedClone, { recursive: true });

      // Surgically remove the agent-context set AND .agent-review/config.json.
      // The config deletion is what gives Task 3.6's seeder a clean slate;
      // without it, dfPresence.configJson=true would cause the merge to
      // treat the file as already-present.
      await rm(join(cleanedClone, "CLAUDE.md"), { force: true });
      await rm(join(cleanedClone, "AGENTS.md"), { force: true });
      await rm(join(cleanedClone, ".claude"), { recursive: true, force: true });
      await rm(join(cleanedClone, "docs"), { recursive: true, force: true });
      await rm(join(cleanedClone, ".agent-review", "config.json"), { force: true });
      // KEEP .husky/ + the rest of .agent-review/ — those are the gate,
      // not the agent context.

      const out = await runOnboardDryRun(cleanedClone);
      plan = out.plan;
    }, 120_000);

    it("metric 1: CLAUDE.md heading retention >= 90%", () => {
      const claudeMdFile = plan.files.find((f) => f.path === "CLAUDE.md");
      expect(claudeMdFile).toBeDefined();
      if (claudeMdFile?.action !== "emit") throw new Error("CLAUDE.md must be emitted");
      const actualHeadings = extractHeadings(claudeMdFile.tailored_content);
      const expectedHeadings = extractHeadings(originalClaudeMd);
      const retention = headingRetention(actualHeadings, expectedHeadings);
      expect(retention).toBeGreaterThanOrEqual(0.9);
    });

    it("metric 2: at least 3 ADRs seeded with non-empty Context + Decision + Consequences + citations", () => {
      const adrs = plan.files.filter(
        (f) => /^docs\/ADR\/\d{4}-\d{2}-.*\.md$/.test(f.path) && f.action === "emit",
      );
      expect(adrs.length).toBeGreaterThanOrEqual(3);
      for (const adr of adrs) {
        if (adr.action !== "emit") continue;
        const body = adr.tailored_content;
        expect(body).toMatch(/^## Context\s*$/m);
        expect(body).toMatch(/^## Decision\s*$/m);
        expect(body).toMatch(/^## Consequences\s*$/m);
        // Non-empty sections.
        const sections = body.split(/^## /m).slice(1);
        for (const s of sections) {
          const sectionBody = s.split("\n").slice(1).join("\n").trim();
          expect(sectionBody.length).toBeGreaterThan(0);
        }
        // At least one citation — a path-like token under repo conventions.
        expect(body).toMatch(/`[A-Za-z0-9_./-]+\.(md|yml|json|ts|tsx|js|py|toml|lock)`/);
      }
    });

    it("metric 3: cycle1 bootstrap doc emitted with real services/stack/deploy story", () => {
      const c1 = plan.files.find(
        (f) => /^docs\/roadmap\/cycles\/cycle1-.*\.md$/.test(f.path) && f.action === "emit",
      );
      expect(c1).toBeDefined();
      if (c1?.action !== "emit") throw new Error("cycle1 bootstrap must be emitted");
      const body = c1.tailored_content;
      expect(body).toMatch(/^## Stack\s*$/m);
      expect(body).toMatch(/^## Services\s*$/m);
      expect(body).toMatch(/^## Deploy story\s*$/m);
      // No template placeholders remain.
      expect(body).not.toMatch(/\{[a-z_]+\}/);
    });

    it("metric 4: at least one runbook contains a verbatim line from a sage3c CI workflow", () => {
      const runbooks = plan.files.filter(
        (f) => /^docs\/runbooks\/RUNBOOK-.*\.md$/.test(f.path) && f.action === "emit",
      );
      expect(runbooks.length).toBeGreaterThanOrEqual(1);
      const haystacks = runbooks
        .filter((r) => r.action === "emit")
        .map((r) => (r as { tailored_content: string }).tailored_content);
      const found = originalCiCommands.some((cmd) =>
        haystacks.some((h) => h.includes(cmd.trim())),
      );
      expect(found).toBe(true);
    });

    it("metric 5: .agent-review/config.json profile equals the canonical local profile (D3 row 5)", async () => {
      const cfg = plan.files.find(
        (f) =>
          f.path === ".agent-review/config.json" &&
          (f.action === "emit" || f.action === "merge"),
      );
      expect(cfg).toBeDefined();
      if (cfg?.action !== "emit" && cfg?.action !== "merge") {
        throw new Error("config must be emit or merge");
      }
      const actualJson = JSON.parse((cfg as { tailored_content: string }).tailored_content);

      // sage3c does NOT keep Doppler cloud-vendor secrets locally → expected
      // canonical is the `local` profile. Read from the PRODUCTION path the
      // seeder ships at runtime (single source of truth).
      const canonicalRaw = await readFile(
        resolve(
          __dirname,
          "..",
          "..",
          "src",
          "onboard",
          "seeders",
          "agent-review-config",
          "local.canonical.json",
        ),
        "utf8",
      );
      const canonicalJson = JSON.parse(canonicalRaw);

      // Structural equality: drift in critic fleet / aggregation policy /
      // critic id long-form fails the test; drift in JSON formatting
      // (key order, whitespace) does not.
      expect(JSON.stringify(deepSort(actualJson))).toEqual(
        JSON.stringify(deepSort(canonicalJson)),
      );
    });
  },
);
