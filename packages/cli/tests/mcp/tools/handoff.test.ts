// Integration tests for the cycle8 handoff MCP tools.
//
// Drive df_handoff / df_handoffs / df_rehydrate / df_accept over the SDK's
// in-memory transport with injected `gh`/`git` runners (via
// createMcpServer's `_testHandoffGh` / `_testHandoffGit`), so the tools'
// MCP-side wiring (structuredContent shape, isError on refusal, the
// live-state-first ordering) is exercised hermetically — no PATH stub, no
// network. The exhaustive behavior matrix lives in
// tests/handoff/handoff-core.test.ts; here we pin the MCP surface.

import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../../../src/mcp/server.js";
import type {
  ExecResult,
  GhRunner,
  GitRunner,
} from "../../../src/handoff/index.js";

const MARK_O = "<!-- agent-context:v1 -->";
const MARK_C = "<!-- /agent-context:v1 -->";

const OK: ExecResult = { code: 0, stdout: "", stderr: "" };
const out = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });

interface FakeGhOpts {
  branch?: string;
  prForBranch?: string;
  markerIds?: number[];
  commentBody?: string;
  prLabels?: string[];
  stackJson?: string;
}

function fakeGh(opts: FakeGhOpts, calls: string[]): GhRunner {
  const branch = opts.branch ?? "feature/x";
  return async (args) => {
    const a = args.join(" ");
    calls.push(a);
    if (a === "--version") return out("gh 2.0\n");
    if (a === "auth status") return OK;
    if (a.startsWith("pr list --head"))
      return out(opts.prForBranch ? `${opts.prForBranch}\n` : "");
    if (a.startsWith("pr list --label handoff")) return out(opts.stackJson ?? "[]");
    if (a.includes("--json title,headRefName,mergeStateStatus"))
      return out(`  PR\n  branch:    ${branch}\n  mergeable: CLEAN   review: APPROVED\n`);
    if (a.includes("--json headRefName")) return out(`${branch}\n`);
    if (a.includes("--json labels")) return out((opts.prLabels ?? ["handoff"]).join("\n") + "\n");
    if (a.includes("--json number")) return out("77\n");
    if (a.startsWith("pr checks")) return out("all green\n");
    if (a.includes("/comments --paginate --slurp")) {
      const ids = opts.markerIds ?? [];
      return out(JSON.stringify([ids.map((id) => ({ id, body: `${MARK_O} marked` }))]));
    }
    if (a.includes("issues/comments/") && a.includes("--jq .body"))
      return out((opts.commentBody ?? `${MARK_O}\n${MARK_C}`) + "\n");
    if (a.includes("--method PATCH")) return out("https://gh/pull/1#c-patched\n");
    if (a.includes("--method POST")) return out("https://gh/pull/1#c-posted\n");
    return OK; // label create, pr edit, …
  };
}

function fakeGit(opts: { branch?: string } = {}, calls: string[]): GitRunner {
  return async (args) => {
    const a = args.join(" ");
    calls.push(`git ${a}`);
    if (a === "rev-parse --abbrev-ref HEAD") return out(`${opts.branch ?? "feature/x"}\n`);
    return OK; // diff --quiet, push, status, …
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

describe("cycle8 handoff MCP tools", () => {
  it("df_handoff posts the note, labels the PR, returns structured result", async () => {
    const calls: string[] = [];
    const { client, close } = await openClient({
      _testHandoffGh: fakeGh({ prForBranch: "42", markerIds: [] }, calls),
      _testHandoffGit: fakeGit({}, calls),
    });
    try {
      const result = await client.callTool({
        name: "df_handoff",
        arguments: {
          note: `${MARK_O}\n\n**Branch:** feature/x\n\nwhy: chose path 1\n${MARK_C}\n`,
        },
      });
      expect(result.isError).toBeFalsy();
      const s = result.structuredContent as {
        pr: string;
        note_url: string;
        pushed: boolean;
        created_draft_pr: boolean;
        warnings: string[];
      };
      expect(s.pr).toBe("42");
      expect(s.note_url).toMatch(/c-posted/);
      expect(s.pushed).toBe(true);
      expect(calls.some((c) => c.includes("--method POST repos/{owner}/{repo}/issues/42/comments"))).toBe(true);
      expect(calls.some((c) => c.includes("pr edit 42 --add-label handoff"))).toBe(true);
    } finally {
      await close();
    }
  });

  it("df_handoff refuses a secret-shaped note (isError, nothing posted)", async () => {
    const calls: string[] = [];
    const { client, close } = await openClient({
      _testHandoffGh: fakeGh({ prForBranch: "42" }, calls),
      _testHandoffGit: fakeGit({}, calls),
    });
    try {
      const result = await client.callTool({
        name: "df_handoff",
        arguments: {
          note: `${MARK_O}\nleftover: AKIAIOSFODNN7EXAMPLE\n${MARK_C}\n`,
        },
      });
      expect(result.isError).toBe(true);
      expect(calls.some((c) => c.includes("--method POST"))).toBe(false);
      expect(calls.some((c) => c.includes("--method PATCH"))).toBe(false);
      // The matched value is never echoed back — only line numbers.
      const text = (result.content as Array<{ type: string; text?: string }>).find(
        (c) => c.type === "text",
      )?.text;
      expect(text).not.toContain("AKIA");
    } finally {
      await close();
    }
  });

  it("df_handoff refuses a note missing the v1 markers (isError)", async () => {
    const calls: string[] = [];
    const { client, close } = await openClient({
      _testHandoffGh: fakeGh({ prForBranch: "42" }, calls),
      _testHandoffGit: fakeGit({}, calls),
    });
    try {
      const result = await client.callTool({
        name: "df_handoff",
        arguments: { note: "no markers here" },
      });
      expect(result.isError).toBe(true);
      expect(calls.some((c) => c.includes("--method"))).toBe(false);
    } finally {
      await close();
    }
  });

  it("df_rehydrate returns live_state FIRST + the newest note, read-only", async () => {
    const calls: string[] = [];
    const { client, close } = await openClient({
      _testHandoffGh: fakeGh(
        { markerIds: [900], commentBody: `${MARK_O}\nwhy: chose path 1\n${MARK_C}` },
        calls,
      ),
      _testHandoffGit: fakeGit({}, calls),
    });
    try {
      const result = await client.callTool({
        name: "df_rehydrate",
        arguments: { pr: "42" },
      });
      expect(result.isError).toBeFalsy();
      const s = result.structuredContent as {
        pr: string;
        live_state: string;
        checks: string;
        note?: string;
        checkout_hint: string;
      };
      expect(s.pr).toBe("42");
      expect(s.live_state).toMatch(/mergeable: CLEAN/);
      expect(s.note).toContain("why: chose path 1");
      expect(s.checkout_hint).toBe("gh pr checkout 42");
      // The rendered text leads with LIVE STATE (the truth, not the note).
      const text = (result.content as Array<{ type: string; text?: string }>).find(
        (c) => c.type === "text",
      )?.text;
      expect(text?.split("\n")[0]).toMatch(/LIVE STATE/);
      // Read-only: no assignee/label mutation.
      expect(calls.some((c) => c.includes("--add-assignee"))).toBe(false);
      expect(calls.some((c) => c.includes("--remove-label"))).toBe(false);
    } finally {
      await close();
    }
  });

  it("df_rehydrate rejects a non-numeric PR before any gh call (isError)", async () => {
    const calls: string[] = [];
    const { client, close } = await openClient({
      _testHandoffGh: fakeGh({}, calls),
      _testHandoffGit: fakeGit({}, calls),
    });
    try {
      const result = await client.callTool({
        name: "df_rehydrate",
        arguments: { pr: "42; echo PWNED" },
      });
      expect(result.isError).toBe(true);
      expect(calls.some((c) => c.startsWith("pr view"))).toBe(false);
    } finally {
      await close();
    }
  });

  it("df_accept assigns @me, removes the label, and rehydrates", async () => {
    const calls: string[] = [];
    const { client, close } = await openClient({
      _testHandoffGh: fakeGh(
        { markerIds: [900], prLabels: ["handoff"], commentBody: `${MARK_O}\nwhy\n${MARK_C}` },
        calls,
      ),
      _testHandoffGit: fakeGit({}, calls),
    });
    try {
      const result = await client.callTool({
        name: "df_accept",
        arguments: { pr: "42" },
      });
      expect(result.isError).toBeFalsy();
      const s = result.structuredContent as {
        pr: string;
        removed_label: boolean;
        rehydrate: { live_state: string };
      };
      expect(s.pr).toBe("42");
      expect(s.removed_label).toBe(true);
      expect(s.rehydrate.live_state).toMatch(/mergeable/);
      expect(calls.some((c) => c.includes("pr edit 42 --add-assignee @me"))).toBe(true);
      expect(calls.some((c) => c.includes("pr edit 42 --remove-label handoff"))).toBe(true);
    } finally {
      await close();
    }
  });

  it("df_handoffs lists the open stack, sorted oldest → newest", async () => {
    const calls: string[] = [];
    const stack = JSON.stringify([
      {
        number: 42,
        title: "fix",
        headRefName: "feature/x",
        assignees: [],
        updatedAt: "2026-05-29T00:00:00Z",
      },
      {
        number: 7,
        title: "old",
        headRefName: "feature/y",
        assignees: [{ login: "alice" }],
        updatedAt: "2026-05-28T00:00:00Z",
      },
    ]);
    const { client, close } = await openClient({
      _testHandoffGh: fakeGh({ stackJson: stack }, calls),
      _testHandoffGit: fakeGit({}, calls),
    });
    try {
      const result = await client.callTool({ name: "df_handoffs", arguments: {} });
      expect(result.isError).toBeFalsy();
      const s = result.structuredContent as {
        entries: Array<{ number: number; owner?: string }>;
      };
      expect(s.entries.map((e) => e.number)).toEqual([7, 42]);
      expect(s.entries[0]?.owner).toBe("alice");
      expect(s.entries[1]?.owner).toBeUndefined();
      expect(calls.some((c) => c.includes("pr list --label handoff --state open"))).toBe(true);
    } finally {
      await close();
    }
  });
});
