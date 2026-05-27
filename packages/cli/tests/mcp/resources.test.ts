// Integration tests for the cycle5 Phase 1 step 4 resource surface.
//
// Drives `resources/list`, `resources/templates/list`, and
// `resources/read` through the SDK's Client + InMemoryTransport pair.
// Each test sets up a fixture repo with whatever shape that resource
// needs (cycle docs / ADRs / config / etc.) so we exercise the real
// reader code, not mocks.
//
// Pins:
//   - resources/list returns the 6 STATIC resources (cycles, adrs,
//     config-critics, runs-recent, audit-log, principles)
//     — templated ones (cycle, adr, findings) appear in
//     resources/templates/list instead.
//   - resources/read returns the correct mimeType + content shape for
//     each URI: JSON for indexes/data, text/markdown for principles,
//     application/x-ndjson for audit-log.
//   - Templated reads (df://repo/cycle/cycle1, df://repo/adr/<id>)
//     return the same structured payload as the corresponding
//     df_cycle_read / df_adr_read tool calls.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../../src/mcp/server.js";

let root: string;

function writeMinimalConfig(rootDir: string): void {
  mkdirSync(join(rootDir, ".agent-review", "prompts"), { recursive: true });
  writeFileSync(join(rootDir, "CLAUDE.md"), "# CLAUDE\n", "utf8");
  writeFileSync(
    join(rootDir, ".agent-review", "prompts", "local-critic.md"),
    "# local\n",
    "utf8",
  );
  writeFileSync(
    join(rootDir, ".agent-review", "config.json"),
    JSON.stringify({
      version: 1,
      critics: [
        {
          id: "cursor-local",
          name: "Cursor",
          adapter: "cursor-sdk",
          required: true,
          runtime: "local",
          model: { id: "gpt-5.5", params: [] },
        },
      ],
      aggregation: {
        policy: "block-if-any",
        blockingSeverities: ["blocker", "high"],
      },
      git: {
        hookPath: ".husky",
        artifactDir: "agent-reviews",
        artifactScope: "git-common-dir",
      },
      policy: {
        blockOnMissingReview: true,
        blockOnReviewError: true,
        allowEmergencyBypass: true,
        postCommitMode: "async",
      },
      context: {
        guidanceFiles: ["CLAUDE.md"],
        promptFragments: [".agent-review/prompts/local-critic.md"],
        maxChangedFileBytes: 200000,
        includeFullChangedFiles: true,
      },
      validation: {
        runBeforeReview: false,
        resultFile: "agent-reviews/quality-gates/latest.json",
        requiredQualityGates: [],
        optionalQualityGates: [],
      },
      security: {
        redactSecretsInDiagnostics: true,
        treatDiffAsUntrustedInput: true,
      },
    }),
    "utf8",
  );
}

function writeCycleFixture(rootDir: string): void {
  mkdirSync(join(rootDir, "docs", "roadmap", "cycles"), { recursive: true });
  writeFileSync(
    join(rootDir, "docs", "roadmap", "cycles", "cycle1-alpha.md"),
    `---
title: "Cycle 1 — alpha"
status: "done"
owner: "@pj"
target: "2026-01-15"
---

# Cycle 1

## Scope

x
`,
    "utf8",
  );
}

function writeAdrFixture(rootDir: string): void {
  mkdirSync(join(rootDir, "docs", "ADR"), { recursive: true });
  writeFileSync(
    join(rootDir, "docs", "ADR", "2026-05-test.md"),
    `# ADR 2026-05 — Test ADR

- **Status:** Accepted
- **Date:** 2026-05-26
- **Deciders:** PJ

## Context

c

## Decision

d
`,
    "utf8",
  );
}

function writePrinciplesFixture(rootDir: string): void {
  mkdirSync(join(rootDir, "docs"), { recursive: true });
  writeFileSync(
    join(rootDir, "docs", "PRINCIPLES.md"),
    `---
title: "Principles"
status: "current"
---

# Principles

Be excellent.
`,
    "utf8",
  );
}

async function openClient() {
  const server = createMcpServer({ cwd: root });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "df-resources-test", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return {
    client,
    server,
    close: async (): Promise<void> => {
      await client.close();
      await server.close();
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "df-resources-"));
  spawnSync("git", ["init", "-q", "-b", "main", root]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resources (cycle5 Phase 1 step 4)", () => {
  it("resources/list returns the static catalog AND the URIs enumerated by templated `list` callbacks", async () => {
    writeMinimalConfig(root);
    writeCycleFixture(root);
    writeAdrFixture(root);
    writePrinciplesFixture(root);

    const { client, close } = await openClient();
    try {
      const result = await client.listResources();
      // Six STATIC resources + the URIs that the templated resources'
      // `list` callbacks enumerate. With one cycle doc + one ADR
      // fixture, that's the 6 static + 1 cycle + 1 ADR = 8 entries.
      // (`findings/{sha}` has a no-op list callback, so its URIs don't
      // appear here — agents discover SHAs via `runs/recent` instead.)
      expect(result.resources.map((r) => r.uri).sort()).toEqual([
        "df://repo/adr/2026-05-test",
        "df://repo/adrs",
        "df://repo/audit-log",
        "df://repo/config/critics",
        "df://repo/cycle/cycle1",
        "df://repo/cycles",
        "df://repo/principles",
        "df://repo/runs/recent",
      ]);
      // Mimetype is set on each resource so clients render the
      // content correctly without sniffing.
      const principles = result.resources.find((r) => r.uri === "df://repo/principles");
      expect(principles?.mimeType).toBe("text/markdown");
      const audit = result.resources.find((r) => r.uri === "df://repo/audit-log");
      expect(audit?.mimeType).toBe("application/x-ndjson");
    } finally {
      await close();
    }
  });

  it("resources/templates/list returns the templated URI patterns", async () => {
    writeMinimalConfig(root);
    writeCycleFixture(root);
    writeAdrFixture(root);

    const { client, close } = await openClient();
    try {
      const result = await client.listResourceTemplates();
      const uriTemplates = result.resourceTemplates.map((t) => t.uriTemplate).sort();
      // 5 templates: 3 path-templated reads (cycle/adr/findings) +
      // 2 query-templated re-registrations (runs-recent + audit-log)
      // that route the `?param=…` variants. See the comments in
      // src/mcp/resources.ts about why query-only forms need an
      // explicit ResourceTemplate sibling alongside the static base
      // URI registration.
      expect(uriTemplates).toEqual([
        "df://repo/adr/{adr_id}",
        "df://repo/audit-log{?since}",
        "df://repo/cycle/{cycle_id}",
        "df://repo/findings/{commit_sha}",
        "df://repo/runs/recent{?limit}",
      ]);
    } finally {
      await close();
    }
  });

  it("resources/read df://repo/cycles returns the cycle index as JSON", async () => {
    writeMinimalConfig(root);
    writeCycleFixture(root);

    const { client, close } = await openClient();
    try {
      const result = await client.readResource({ uri: "df://repo/cycles" });
      const content = result.contents[0];
      expect(content?.mimeType).toBe("application/json");
      const parsed = JSON.parse(String(content?.text ?? "{}")) as {
        cycles: Array<{ id: string; title: string }>;
      };
      expect(parsed.cycles[0]?.id).toBe("cycle1");
      expect(parsed.cycles[0]?.title).toBe("Cycle 1 — alpha");
    } finally {
      await close();
    }
  });

  it("resources/read df://repo/cycle/{id} returns frontmatter + sections", async () => {
    writeMinimalConfig(root);
    writeCycleFixture(root);

    const { client, close } = await openClient();
    try {
      const result = await client.readResource({ uri: "df://repo/cycle/cycle1" });
      const content = result.contents[0];
      expect(content?.mimeType).toBe("application/json");
      const parsed = JSON.parse(String(content?.text ?? "{}")) as {
        id: string;
        frontmatter: { title?: string };
        sections: Record<string, string>;
      };
      expect(parsed.id).toBe("cycle1");
      expect(parsed.frontmatter?.title).toBe("Cycle 1 — alpha");
      expect(parsed.sections?.scope).toBeDefined();
    } finally {
      await close();
    }
  });

  it("resources/read df://repo/cycle/{id} throws for an unknown id", async () => {
    writeMinimalConfig(root);
    writeCycleFixture(root);

    const { client, close } = await openClient();
    try {
      await expect(
        client.readResource({ uri: "df://repo/cycle/cycle999" }),
      ).rejects.toThrow(/cycle999/);
    } finally {
      await close();
    }
  });

  it("resources/read df://repo/adrs and df://repo/adr/{id}", async () => {
    writeMinimalConfig(root);
    writeAdrFixture(root);

    const { client, close } = await openClient();
    try {
      const list = await client.readResource({ uri: "df://repo/adrs" });
      const listParsed = JSON.parse(String(list.contents[0]?.text ?? "{}")) as {
        adrs: Array<{ id: string }>;
      };
      expect(listParsed.adrs[0]?.id).toBe("2026-05-test");

      const single = await client.readResource({ uri: "df://repo/adr/2026-05-test" });
      const singleParsed = JSON.parse(String(single.contents[0]?.text ?? "{}")) as {
        id: string;
        status: string;
        body: string;
      };
      expect(singleParsed.id).toBe("2026-05-test");
      expect(singleParsed.status).toBe("Accepted");
      expect(singleParsed.body).toMatch(/## Context/);
    } finally {
      await close();
    }
  });

  it("resources/read df://repo/config/critics returns the FULL loaded config", async () => {
    writeMinimalConfig(root);

    const { client, close } = await openClient();
    try {
      const result = await client.readResource({ uri: "df://repo/config/critics" });
      const parsed = JSON.parse(String(result.contents[0]?.text ?? "{}")) as {
        critics: Array<{ id: string }>;
        aggregation: { policy: string };
        // The RESOURCE surface returns the full config (unlike the
        // df_critics_config tool which narrows to critics + aggregation
        // + prompts). Pin a couple of additional fields to lock that
        // distinction.
        policy: { allowEmergencyBypass: boolean };
        validation: { resultFile: string };
      };
      expect(parsed.critics[0]?.id).toBe("cursor-local");
      expect(parsed.aggregation?.policy).toBe("block-if-any");
      expect(parsed.policy?.allowEmergencyBypass).toBe(true);
      expect(parsed.validation?.resultFile).toBeTruthy();
    } finally {
      await close();
    }
  });

  it("resources/read df://repo/principles returns the markdown verbatim", async () => {
    writeMinimalConfig(root);
    writePrinciplesFixture(root);

    const { client, close } = await openClient();
    try {
      const result = await client.readResource({ uri: "df://repo/principles" });
      const content = result.contents[0];
      expect(content?.mimeType).toBe("text/markdown");
      expect(String(content?.text ?? "")).toMatch(/^---\ntitle: "Principles"/);
      expect(String(content?.text ?? "")).toMatch(/Be excellent\./);
    } finally {
      await close();
    }
  });

  it("resources/read df://repo/principles throws when docs/PRINCIPLES.md is absent", async () => {
    writeMinimalConfig(root);
    // Note: no writePrinciplesFixture call.

    const { client, close } = await openClient();
    try {
      await expect(
        client.readResource({ uri: "df://repo/principles" }),
      ).rejects.toThrow(/PRINCIPLES\.md/);
    } finally {
      await close();
    }
  });

  it("resources/read df://repo/runs/recent honors ?limit and returns a JSON view", async () => {
    writeMinimalConfig(root);
    // Seed a synthetic NDJSON audit trail with 3 events. The exact
    // shape doesn't matter for the resource — it just reverses +
    // slices.
    mkdirSync(join(root, ".git", "agent-reviews"), { recursive: true });
    const events = [
      { ts: "2026-05-01T00:00:00.000Z", event: "review_started", commit: "a" },
      { ts: "2026-05-02T00:00:00.000Z", event: "review_finished", commit: "b" },
      { ts: "2026-05-03T00:00:00.000Z", event: "review_started", commit: "c" },
    ];
    writeFileSync(
      join(root, ".git", "agent-reviews", "_runs.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );

    const { client, close } = await openClient();
    try {
      // No limit param → default 25
      const dflt = await client.readResource({ uri: "df://repo/runs/recent" });
      const dfltParsed = JSON.parse(String(dflt.contents[0]?.text ?? "{}")) as {
        events: Array<{ commit: string }>;
        total_scanned: number;
        limit: number;
      };
      expect(dfltParsed.total_scanned).toBe(3);
      expect(dfltParsed.limit).toBe(25);
      // Newest-first
      expect(dfltParsed.events[0]?.commit).toBe("c");

      // Explicit ?limit=2
      const limited = await client.readResource({
        uri: "df://repo/runs/recent?limit=2",
      });
      const limitedParsed = JSON.parse(String(limited.contents[0]?.text ?? "{}")) as {
        events: Array<{ commit: string }>;
        limit: number;
      };
      expect(limitedParsed.events).toHaveLength(2);
      expect(limitedParsed.limit).toBe(2);
    } finally {
      await close();
    }
  });

  it("resources/read df://repo/audit-log returns NDJSON; ?since filters by ts", async () => {
    writeMinimalConfig(root);
    mkdirSync(join(root, ".git", "agent-reviews"), { recursive: true });
    const events = [
      { ts: "2026-05-01T00:00:00.000Z", event: "gate_passed", commit: "a" },
      { ts: "2026-05-02T00:00:00.000Z", event: "gate_blocked", commit: "b" },
      { ts: "2026-05-03T00:00:00.000Z", event: "gate_bypassed", commit: "c" },
    ];
    writeFileSync(
      join(root, ".git", "agent-reviews", "_runs.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );

    const { client, close } = await openClient();
    try {
      const all = await client.readResource({ uri: "df://repo/audit-log" });
      const allContent = all.contents[0];
      expect(allContent?.mimeType).toBe("application/x-ndjson");
      const allLines = String(allContent?.text ?? "")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(allLines).toHaveLength(3);

      const sinceMay2 = await client.readResource({
        uri: "df://repo/audit-log?since=2026-05-02T00:00:00.000Z",
      });
      const filtered = String(sinceMay2.contents[0]?.text ?? "")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(filtered).toHaveLength(2); // May-02 + May-03 entries
    } finally {
      await close();
    }
  });
});
