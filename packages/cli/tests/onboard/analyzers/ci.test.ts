// packages/cli/tests/onboard/analyzers/ci.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciAnalyzer } from "../../../src/onboard/analyzers/ci.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ci-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function writeWorkflow(root: string, name: string, body: string) {
  await mkdir(join(root, ".github", "workflows"), { recursive: true });
  await writeFile(join(root, ".github", "workflows", name), body);
}

describe("ciAnalyzer", () => {
  it("returns null when .github/workflows is absent", async () => {
    expect(await ciAnalyzer.detect(root)).toBeNull();
  });

  it("parses a basic CI workflow", async () => {
    await writeWorkflow(root, "ci.yml",
      `name: CI\non:\n  push:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`);
    const r = await ciAnalyzer.detect(root);
    expect(r?.ci?.workflows).toHaveLength(1);
    expect(r?.ci?.workflows?.[0]).toMatchObject({
      name: "CI", path: ".github/workflows/ci.yml",
      triggers: expect.arrayContaining(["push", "pull_request"]),
      jobs: ["test"],
    });
    expect(r?.ci?.deployStory).toBeNull();
  });

  it("detects a helm deploy story", async () => {
    await writeWorkflow(root, "release.yml",
      `name: Release\non:\n  push:\n    tags: ['v*']\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: helm upgrade myapp ./chart\n`);
    const r = await ciAnalyzer.detect(root);
    expect(r?.ci?.deployStory).toEqual({
      workflowPath: ".github/workflows/release.yml",
      command: "helm upgrade myapp ./chart",
      target: "helm",
    });
  });

  it("detects matrix dimensions", async () => {
    await writeWorkflow(root, "test.yml",
      `name: Test\non: push\njobs:\n  test:\n    runs-on: \${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, macos-latest]\n        node: [20, 22]\n    steps:\n      - run: npm test\n`);
    const r = await ciAnalyzer.detect(root);
    expect(r?.ci?.workflows?.[0]?.matrixDimensions).toEqual(expect.arrayContaining(["os", "node"]));
  });

  it("detects a kubectl apply deploy story", async () => {
    await writeWorkflow(root, "deploy.yml",
      `name: Deploy\non: push\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: kubectl apply -f k8s/\n`);
    const r = await ciAnalyzer.detect(root);
    expect(r?.ci?.deployStory).toEqual({
      workflowPath: ".github/workflows/deploy.yml",
      command: "kubectl apply -f k8s/",
      target: "kubernetes",
    });
  });

  // Fix #138 — capture per-workflow firstRunCommand for the seeder's donor
  // fallback. The analyzer's deployStory contract is unchanged (still
  // DEPLOY_VERB matches only); this adds a per-workflow signal the seeder
  // consumes when no deploy-named workflow has a single-line `run:`.

  it("captures firstRunCommand from a single-line `run:` step", async () => {
    await writeWorkflow(root, "ci.yml",
      `name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: poetry install --no-interaction --no-root\n      - run: poetry run pytest\n`);
    const r = await ciAnalyzer.detect(root);
    expect(r?.ci?.workflows?.[0]?.firstRunCommand).toBe(
      "poetry install --no-interaction --no-root",
    );
  });

  it("returns null firstRunCommand for workflows with ONLY multi-line `run: |` blocks", async () => {
    // Mirrors sage3c's promote-to-prod.yml shape — every step uses block scalar
    // `run: |`, so there is no single-line `run:` for the validator's regex to
    // catch via firstRunCommand. This is the case where the seeder must pull a
    // donor workflow instead.
    await writeWorkflow(root, "promote.yml",
      `name: Promote\non: workflow_dispatch\njobs:\n  promote:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          if [ ! -f staging.yaml ]; then exit 1; fi\n          cat staging.yaml\n      - run: |\n          git push origin main\n`);
    const r = await ciAnalyzer.detect(root);
    expect(r?.ci?.workflows?.[0]?.firstRunCommand).toBeNull();
  });

  it("returns null firstRunCommand when steps are only composite-action `uses:`", async () => {
    // Release-please-action and similar composite GitHub Actions surface as
    // `uses:` steps with no `run:` line. The seeder needs a non-null donor
    // somewhere in `workflows[]` for these repos to satisfy metric 4.
    await writeWorkflow(root, "release-please.yml",
      `name: Release Please\non:\n  push:\n    branches: [main]\njobs:\n  release-please:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: googleapis/release-please-action@v4\n        with:\n          release-type: node\n`);
    const r = await ciAnalyzer.detect(root);
    expect(r?.ci?.workflows?.[0]?.firstRunCommand).toBeNull();
  });

  it("preserves the existing non-deploy-named single-line `run:` capture even when no deploy story is found", async () => {
    await writeWorkflow(root, "test.yml",
      `name: Test\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: poetry run pytest -xvs\n`);
    const r = await ciAnalyzer.detect(root);
    // Test isn't a deploy-named workflow → no deploy story. But the
    // firstRunCommand is still captured per-workflow for the seeder's donor
    // fallback.
    expect(r?.ci?.deployStory).toBeNull();
    expect(r?.ci?.workflows?.[0]?.firstRunCommand).toBe("poetry run pytest -xvs");
  });

  it("skips trivial single-line `run:` (≤10 chars) for firstRunCommand", async () => {
    // Guards the >10 chars threshold — `npm test` (8 chars) is too short to
    // be a useful runbook citation, so the seeder's donor pass would skip it.
    await writeWorkflow(root, "test.yml",
      `name: Test\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n`);
    const r = await ciAnalyzer.detect(root);
    expect(r?.ci?.workflows?.[0]?.firstRunCommand).toBeNull();
  });
});
