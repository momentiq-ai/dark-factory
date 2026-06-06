// Cycle 15 Phase C — regression test on the agent_context.* check group.
//
// Pins the cycle-15 exit criterion (lines 297–303 of the plan):
//   "All current repos must pass `df doctor` after this lands (regression
//    check against this repo + dark-factory-dashboard + sage3c)."
//
// The full runDoctor path is exercised by tests/cli-help.test.ts /
// cli-subcommands.test.ts (CLI integration smoke). Here we pin the contract
// at the check-function level: the three reference repos (DFP, dashboard,
// sage3c) all have the full agent-context set, so synthetic fixtures
// mirroring their minimal shapes must all return all-pass.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkAgentContextSet } from "../../src/onboard/validate.js";

interface RefRepoShape {
  name: string;
  files: Record<string, string>;
}

const DFP_LIKE: RefRepoShape = {
  name: "dfp-like",
  files: {
    "CLAUDE.md": "# CLAUDE\n",
    "AGENTS.md": "# AGENTS\n",
    ".claude/settings.json": "{}",
    "docs/PRINCIPLES.md": "# PRINCIPLES\n",
    "docs/roadmap/cycles/cycle1-dashboard-installation-linking.md":
      "# cycle 1\n",
    ".agent-review/config.json": "{}",
  },
};

const DASHBOARD_LIKE: RefRepoShape = {
  name: "dashboard-like",
  files: {
    "CLAUDE.md": "# CLAUDE\n",
    "AGENTS.md": "# AGENTS\n",
    ".claude/settings.json": "{}",
    "docs/PRINCIPLES.md": "# PRINCIPLES\n",
    "docs/roadmap/cycles/cycle1-dashboard-bootstrap.md": "# cycle 1\n",
    ".agent-review/config.json": "{}",
  },
};

const SAGE3C_LIKE: RefRepoShape = {
  name: "sage3c-like",
  files: {
    "CLAUDE.md": "# CLAUDE (sage)\n",
    "AGENTS.md": "# AGENTS (sage)\n",
    ".claude/settings.json": "{}",
    "docs/PRINCIPLES.md": "# PRINCIPLES\n",
    "docs/roadmap/cycles/cycle1-sage-bootstrap.md": "# cycle 1\n",
    ".agent-review/config.json": "{}",
  },
};

describe.each([DFP_LIKE, DASHBOARD_LIKE, SAGE3C_LIKE])(
  "checkAgentContextSet regression: $name",
  (shape) => {
    let root: string;
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), `${shape.name}-`));
      for (const [rel, body] of Object.entries(shape.files)) {
        const full = join(root, rel);
        await mkdir(join(full, ".."), { recursive: true });
        await writeFile(full, body);
      }
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("all agent-context checks pass for a well-formed repo", async () => {
      const checks = await checkAgentContextSet({
        repoRoot: root,
        guidanceFiles: [],
      });
      const required = checks.filter(
        (c) =>
          c.name.startsWith("agent_context.") &&
          c.name !== "agent_context.guidance_not_configured",
      );
      expect(required.length).toBe(6); // 6 required-file checks
      for (const c of required) {
        expect(c.passed).toBe(true);
      }
    });
  },
);
