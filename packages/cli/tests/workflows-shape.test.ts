// Workflow-shape regression tests for the reusable workflows shipped at
// `.github/workflows/*.yml`. Each workflow's surfaced check-context name is
// load-bearing for consumer rulesets — drift breaks merges silently. See
// issue #27 (pr-status-check display-name) and issue #29 (agent-critic
// timeout-minutes).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

// REPO_ROOT resolves to the workspace root regardless of where vitest is
// invoked from (the file lives at packages/cli/tests/ so we ascend two
// levels). Mirrors the resolution pattern used by the Python audit suite
// at packages/cli/tests/branch-protection/conftest.py.
const REPO_ROOT = join(__dirname, "..", "..", "..");

interface WorkflowJob {
  name?: string;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  steps?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

interface WorkflowDoc {
  name?: string;
  jobs?: Record<string, WorkflowJob>;
  [k: string]: unknown;
}

function loadWorkflow(rel: string): WorkflowDoc {
  const path = join(REPO_ROOT, ".github", "workflows", rel);
  return parseYaml(readFileSync(path, "utf8")) as WorkflowDoc;
}

describe("pr-status-check workflow shape (issue #27)", () => {
  // The surfaced status-check context is `<caller-job-id> / <callee-job-name>`.
  // If the callee job carries a `name:` override the context becomes
  // `pr-status-check / <override>`, which does NOT match the documented
  // `pr-status-check / pr-status-check` ruleset string and permanently
  // blocks consumer merges. Removing the `name:` aligns context with id.
  it("the pr-status-check job has NO display `name:` override (context must equal job id)", () => {
    const doc = loadWorkflow("pr-status-check.yml");
    const job = doc.jobs?.["pr-status-check"];
    expect(job, "pr-status-check job missing").toBeDefined();
    expect(
      job!.name,
      "issue #27: pr-status-check job carries a `name:` override; this " +
        "breaks the documented `pr-status-check / pr-status-check` " +
        "required-context match for every consumer ruleset.",
    ).toBeUndefined();
  });

  it("declares pull_request, merge_group, and workflow_call triggers", () => {
    const doc = loadWorkflow("pr-status-check.yml");
    // YAML parses `on: {...}` as an object; the bare-key forms (`merge_group:`
    // with no value) parse as `null` properties on that object.
    const on = doc["on"] as Record<string, unknown> | undefined;
    expect(on).toBeDefined();
    expect("pull_request" in on!).toBe(true);
    expect("merge_group" in on!).toBe(true);
    expect("workflow_call" in on!).toBe(true);
  });
});

describe("agent-critic workflow shape (issue #29)", () => {
  it("the agent-critic job has NO display `name:` that diverges from the id", () => {
    // Issue #27 is pr-status-check specific (the only one with a divergent
    // display name), but the same shape rule applies — if anyone ever adds
    // a `name:` to agent-critic, the same context-mismatch class of bug
    // re-emerges. Lock it down at the same time.
    const doc = loadWorkflow("agent-critic.yml");
    const job = doc.jobs?.["agent-critic"];
    expect(job).toBeDefined();
    // Either no `name:` at all, OR name equals the job id.
    if (job!.name !== undefined) {
      expect(job!.name).toBe("agent-critic");
    }
  });

  it("the agent-critic job timeout-minutes is raised above the historical ~10m flake boundary", () => {
    // Issue #29: empirically, `agent-critic` cancels at ~10m on moderate
    // diffs (taxpilot2a PR #72 evidence: 4m25s / 9m59s / 10m18s-canceled).
    // The job must be given enough headroom that wall-clock variance in
    // the critic SDK calls cannot cancel the job before the CLI finishes
    // (and reports a verdict or error).
    const doc = loadWorkflow("agent-critic.yml");
    const job = doc.jobs?.["agent-critic"];
    expect(job).toBeDefined();
    const t = job!["timeout-minutes"];
    expect(typeof t).toBe("number");
    // The fix lands at 20m: ~2x the prior flake boundary, well under the
    // 60m action default. Tightening below 15m re-introduces the symptom;
    // loosening above 30m wastes consumer minutes for the long-tail case.
    expect(t as number).toBeGreaterThanOrEqual(15);
    expect(t as number).toBeLessThanOrEqual(30);
  });
});
