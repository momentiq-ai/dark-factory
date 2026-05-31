// Integration tests for the Cycle 12 (Issue-anchored) handoff MCP tools.
//
// Drive df_handoff / df_handoffs / df_rehydrate / df_accept over the SDK's
// in-memory transport with injected `gh`/`git` runners (via
// createMcpServer's `_testHandoffGh` / `_testHandoffGit`), so the tools'
// MCP-side wiring (structuredContent shape, isError on refusal, the
// live-state-first ordering) is exercised hermetically — no PATH stub, no
// network. The exhaustive behavior matrix lives in
// tests/handoff/handoff-core.test.ts; here we pin the MCP surface.

import { beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../../../src/mcp/server.js";
import {
  _resetMeLoginCacheForTest,
  type ExecResult,
  type GhRunner,
  type GitRunner,
} from "../../../src/handoff/index.js";

const MARK_O = "<!-- agent-context:v1 -->";
const MARK_C = "<!-- /agent-context:v1 -->";

const OK: ExecResult = { code: 0, stdout: "", stderr: "" };
const out = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });

const ME = "alice";

interface FakeGhOpts {
  /** When true, `issue view <issue> --json state,labels,assignees,body,updatedAt`
   * returns an OPEN handoff with the supplied body. */
  issueBody?: string;
  /** Override for the issue's state (default: OPEN). */
  state?: string;
  /** Override for the issue's labels (default: ['handoff']). */
  labels?: string[];
  /** Override for the issue's assignees (default: []). */
  assignees?: Array<{ login: string }>;
  /** Stack JSON for `issue list --label handoff --state open --search no:assignee`. */
  stackJson?: string;
}

function fakeGh(opts: FakeGhOpts, calls: string[]): GhRunner {
  const labels = opts.labels ?? ["handoff"];
  const assignees = opts.assignees ?? [];
  const state = opts.state ?? "OPEN";
  const body = opts.issueBody ?? `${MARK_O}\nreasoning\n${MARK_C}\n`;
  const updatedAt = "2026-05-30T00:00:00Z";
  return async (args) => {
    const a = args.join(" ");
    calls.push(a);
    if (a === "--version") return out("gh 2.0\n");
    if (a === "auth status") return OK;
    if (a === "api user --jq .login") return out(`${ME}\n`);
    if (a.startsWith("issue list --label handoff --state open --search no:assignee")) {
      return out(opts.stackJson ?? "[]");
    }
    if (a.startsWith("issue list --label handoff --state open --assignee @me")) {
      return out("");
    }
    if (a.startsWith("issue list --label handoff --state closed --assignee @me")) {
      return out("");
    }
    // Issue view variants (different --json field lists).
    if (a.startsWith("issue view ") && a.includes("--json state,labels,assignees,body,updatedAt")) {
      return out(
        JSON.stringify({
          state,
          labels: labels.map((n) => ({ name: n })),
          assignees,
          body,
          updatedAt,
        }),
      );
    }
    if (a.startsWith("issue view ") && a.includes("--json state,assignees,body,updatedAt")) {
      return out(JSON.stringify({ state, assignees, body, updatedAt }));
    }
    if (a.startsWith("issue view ") && a.includes("--json state,assignees,updatedAt")) {
      return out(JSON.stringify({ state, assignees, updatedAt }));
    }
    if (a.startsWith("issue view ") && a.includes("--json assignees")) {
      // Post-assign verify: assume the assign succeeded.
      return out(JSON.stringify({ assignees: [{ login: ME }] }));
    }
    if (a.startsWith("issue view ") && a.includes("--json number,title,state,assignees,labels,closedAt,updatedAt,body")) {
      return out(
        JSON.stringify({
          number: 42,
          title: "test handoff",
          state,
          assignees,
          labels: labels.map((n) => ({ name: n })),
          closedAt: null,
          updatedAt,
          body,
        }),
      );
    }
    if (a.startsWith("issue edit")) return OK;
    if (a.startsWith("issue close")) return OK;
    if (a.startsWith("issue create")) return out("https://github.com/o/r/issues/100\n");
    if (a.startsWith("label create")) return OK;
    if (a.startsWith("pr list --head")) return out("[]");
    return OK;
  };
}

function fakeGit(calls: string[]): GitRunner {
  return async (args) => {
    const a = args.join(" ");
    calls.push(`git ${a}`);
    if (a === "rev-parse --abbrev-ref HEAD") return out("feature/x\n");
    if (a === "diff --quiet") return OK;
    if (a === "diff --cached --quiet") return OK;
    return OK;
  };
}

async function openClient(serverOpts: Parameters<typeof createMcpServer>[0]) {
  const server = createMcpServer(serverOpts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "t", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

beforeEach(() => {
  _resetMeLoginCacheForTest();
});

describe("cycle12 handoff MCP tools", () => {
  it("df_handoff updates an explicit handoff issue, returns structured result", async () => {
    const calls: string[] = [];
    const { client, close } = await openClient({
      _testHandoffGh: fakeGh({}, calls),
      _testHandoffGit: fakeGit(calls),
    });
    try {
      const result = await client.callTool({
        name: "df_handoff",
        arguments: {
          note: `${MARK_O}\n\n**Branch:** feature/x\n\nwhy: chose path 1\n${MARK_C}\n`,
          issue: "42",
        },
      });
      expect(result.isError).toBeFalsy();
      const s = result.structuredContent as {
        issue: string;
        note_url: string;
        created: boolean;
        warnings: string[];
      };
      expect(s.issue).toBe("42");
      expect(s.created).toBe(false);
      expect(calls.some((c) => c.startsWith("issue edit 42 --body-file"))).toBe(true);
      expect(calls.some((c) => c === "issue edit 42 --add-label handoff")).toBe(true);
    } finally {
      await close();
    }
  });

  it("df_handoff refuses a secret-shaped note (isError, nothing posted)", async () => {
    const calls: string[] = [];
    const { client, close } = await openClient({
      _testHandoffGh: fakeGh({}, calls),
      _testHandoffGit: fakeGit(calls),
    });
    try {
      const result = await client.callTool({
        name: "df_handoff",
        arguments: {
          note: `${MARK_O}\nleftover: AKIAIOSFODNN7EXAMPLE\n${MARK_C}\n`,
          issue: "42",
        },
      });
      expect(result.isError).toBe(true);
      expect(calls.some((c) => c.startsWith("issue edit"))).toBe(false);
      expect(calls.some((c) => c.startsWith("issue create"))).toBe(false);
      // The matched value is never echoed back — only line numbers.
      const text = (result.content as Array<{ type: string; text?: string }>).find(
        (c) => c.type === "text",
      )?.text;
      expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    } finally {
      await close();
    }
  });

  it("df_handoff refuses a note missing the v1 markers (isError)", async () => {
    const calls: string[] = [];
    const { client, close } = await openClient({
      _testHandoffGh: fakeGh({}, calls),
      _testHandoffGit: fakeGit(calls),
    });
    try {
      const result = await client.callTool({
        name: "df_handoff",
        arguments: { note: "no markers here", issue: "42" },
      });
      expect(result.isError).toBe(true);
      expect(calls.some((c) => c.startsWith("issue edit"))).toBe(false);
    } finally {
      await close();
    }
  });

  it("df_rehydrate returns the live-state text + reasoning, read-only", async () => {
    const calls: string[] = [];
    const { client, close } = await openClient({
      _testHandoffGh: fakeGh({}, calls),
      _testHandoffGit: fakeGit(calls),
    });
    try {
      const result = await client.callTool({
        name: "df_rehydrate",
        arguments: { issue: "42" },
      });
      expect(result.isError).toBeFalsy();
      const s = result.structuredContent as {
        issue: string;
        text: string;
        has_unreachable: boolean;
      };
      expect(s.issue).toBe("42");
      expect(s.text).toMatch(/LIVE STATE/);
      expect(s.text).toContain("reasoning");
      // Read-only: no mutating calls.
      expect(calls.some((c) => c.startsWith("issue edit"))).toBe(false);
      expect(calls.some((c) => c.startsWith("issue close"))).toBe(false);
    } finally {
      await close();
    }
  });

  it("df_rehydrate rejects a non-numeric issue before any gh call (isError)", async () => {
    const calls: string[] = [];
    const { client, close } = await openClient({
      _testHandoffGh: fakeGh({}, calls),
      _testHandoffGit: fakeGit(calls),
    });
    try {
      const result = await client.callTool({
        name: "df_rehydrate",
        arguments: { issue: "42; echo PWNED" },
      });
      expect(result.isError).toBe(true);
      expect(calls.some((c) => c.startsWith("issue view"))).toBe(false);
    } finally {
      await close();
    }
  });

  it("df_accept runs the atomic chain (assign + close)", async () => {
    const calls: string[] = [];
    const { client, close } = await openClient({
      _testHandoffGh: fakeGh({}, calls),
      _testHandoffGit: fakeGit(calls),
    });
    try {
      const result = await client.callTool({
        name: "df_accept",
        arguments: { issue: "42" },
      });
      expect(result.isError).toBeFalsy();
      const s = result.structuredContent as {
        issue: string;
        rehydrate: { issue: string; text: string; has_unreachable: boolean };
      };
      expect(s.issue).toBe("42");
      expect(s.rehydrate.text).toMatch(/LIVE STATE/);
      expect(calls.some((c) => c === "issue edit 42 --add-assignee @me")).toBe(true);
      expect(calls.some((c) => c === "issue close 42")).toBe(true);
    } finally {
      await close();
    }
  });

  it("df_handoffs lists the open unassigned stack (issue-list, with linked count)", async () => {
    const calls: string[] = [];
    const stack = JSON.stringify([
      {
        number: 7,
        title: "old",
        createdAt: "2026-05-28T00:00:00Z",
        updatedAt: "2026-05-28T00:00:00Z",
        body: "",
      },
      {
        number: 42,
        title: "fix",
        createdAt: "2026-05-29T00:00:00Z",
        updatedAt: "2026-05-29T00:00:00Z",
        body: `${MARK_O}\n**Linked work items:**\n- pr #100 — a\n- issue #200 — b\n${MARK_C}\n`,
      },
    ]);
    const { client, close } = await openClient({
      _testHandoffGh: fakeGh({ stackJson: stack }, calls),
      _testHandoffGit: fakeGit(calls),
    });
    try {
      const result = await client.callTool({ name: "df_handoffs", arguments: {} });
      expect(result.isError).toBeFalsy();
      const s = result.structuredContent as {
        rows: Array<{ number: number; title: string; age: string; linked_count: number }>;
      };
      expect(s.rows.map((r) => r.number)).toEqual([7, 42]);
      expect(s.rows[0]?.linked_count).toBe(0);
      expect(s.rows[1]?.linked_count).toBe(2);
      expect(
        calls.some((c) =>
          c.startsWith("issue list --label handoff --state open --search no:assignee"),
        ),
      ).toBe(true);
    } finally {
      await close();
    }
  });
});
