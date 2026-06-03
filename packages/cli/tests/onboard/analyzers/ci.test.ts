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
});
