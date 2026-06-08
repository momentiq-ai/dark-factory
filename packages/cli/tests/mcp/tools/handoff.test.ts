// packages/cli/tests/mcp/tools/handoff.test.ts
//
// Behavioral MCP tests for the v2 handoff tools (df_handoff / df_accept /
// df_rehydrate / df_handoffs) shipped at Task 24 of cycle12.2.
//
// Replaces the v1 Cycle 8 tool tests deleted at Task 22. v1 wired
// `_testHandoffGh`/`_testHandoffGit` function-runners on CreateMcpServerOptions;
// v2 instead exposes object-shaped GhClient/GitClient/Clock test seams on
// `RegisterHandoffToolsOptions` (see src/mcp/tools/handoff.ts +
// src/mcp/server.ts:85-91 for the design rationale). We therefore drive these
// tests by calling `registerHandoffTools(server, {_gh, _git, _clock})` directly
// on a freshly-constructed McpServer — closer to a unit test, no detour through
// createMcpServer, and no contamination of CreateMcpServerOptions with handoff
// test seams that the cycle12.2 server.ts comment explicitly says NOT to add.
//
// Test injection pattern:
//   - FakeGhClient / FakeGitClient / FixedClock from tests/handoff/fixtures/stubs/
//   - Drive the MCP server with the SDK's InMemoryTransport pair (same as
//     server.test.ts) so we exercise the JSON-RPC framing end to end.
//   - Assert BOTH structuredContent (typed) AND content[0].text (bash-compatible
//     rendered form), since the v2 tools' contract is "return both".
//   - Error paths surface via `isError: true` (the SDK wraps a thrown
//     HandoffError into that shape automatically — same pattern as
//     `df_cycle_read with an unknown id` in tests/mcp/server.test.ts).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { registerHandoffTools } from "../../../src/mcp/tools/handoff.js";
import type {
  IssueListItem,
  IssueView,
  IssueViewSlim,
} from "../../../src/handoff/ports.js";
import { FakeGhClient } from "../../handoff/fixtures/stubs/fake-gh.js";
import { FakeGitClient } from "../../handoff/fixtures/stubs/fake-git.js";
import { FixedClock } from "../../handoff/fixtures/stubs/fixed-clock.js";

const MARK_O = "<!-- agent-context:v1 -->";
const MARK_C = "<!-- /agent-context:v1 -->";

// FixedClock epoch = 1780142400 = 2026-05-30T12:00:00Z; ymd = 2026-05-30.
// Matches the canonical setup() helper in the verb-level handoff tests.
const NOW_EPOCH = 1780142400;
const NOW_YMD = "2026-05-30";

/** Minimal valid agent-context note (same shape as the verb-level tests). */
const NOTE = `${MARK_O}
_Updated: 2026-05-30 by claude-opus-4-8 session_

**Why this approach (and what I rejected):**
- chose path 1 over path 2

**Where I was mid-thought:**
- here
${MARK_C}
`;

/** Body containing exactly one well-formed agent-context block. */
function bodyWithBlock(): string {
  return `${MARK_O}\n_Updated: 2026-05-29_\n\nwhy: prior reasoning\n${MARK_C}`;
}

function issueView(overrides: Partial<IssueView> = {}): IssueView {
  return {
    number: 42,
    title: "Handoff: example",
    body: bodyWithBlock(),
    state: "OPEN",
    assignees: [],
    labels: [{ name: "handoff" }],
    updatedAt: "2026-05-30T00:00:00Z",
    closedAt: null,
    ...overrides,
  };
}

function slimView(overrides: Partial<IssueViewSlim> = {}): IssueViewSlim {
  return {
    state: "OPEN",
    assignees: [],
    updatedAt: "2026-05-30T00:00:00Z",
    ...overrides,
  };
}

function listItem(
  overrides: Partial<IssueListItem> & { number: number },
): IssueListItem {
  return {
    title: "stack item",
    assignees: [],
    body: "",
    createdAt: "2026-05-29T00:00:00Z",
    updatedAt: "2026-05-30T00:00:00Z",
    closedAt: undefined,
    ...overrides,
  };
}

/**
 * Spin up a fresh McpServer, register ONLY the handoff tools with injected
 * fakes, wire an in-memory transport pair, and connect a high-level Client.
 *
 * The test seam pattern mirrors what server.ts comment lines 85-91 prescribe —
 * v2 test seams live on `registerHandoffTools`' options, NOT on
 * CreateMcpServerOptions. We deliberately bypass `createMcpServer` here so
 * adding handoff seams to that surface remains unnecessary.
 */
async function withHandoffMcp(
  testFn: (
    client: Client,
    gh: FakeGhClient,
    git: FakeGitClient,
    clock: FixedClock,
  ) => Promise<void>,
): Promise<void> {
  const gh = new FakeGhClient();
  const git = new FakeGitClient();
  const clock = new FixedClock(NOW_EPOCH, NOW_YMD);

  const server = new McpServer(
    { name: "df-handoff-test/mcp", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  registerHandoffTools(server, { _gh: gh, _git: git, _clock: clock });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client(
    { name: "df-handoff-test", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  try {
    await testFn(client, gh, git, clock);
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * Read the first text-typed content item from a tool result. Each tool's
 * `content[0]` is always a `{ type: "text", text: ... }` per the v2 contract;
 * the assertion isolates the text we want to match against without forcing
 * each caller to repeat the cast.
 */
function firstText(result: { content: unknown }): string | undefined {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((c) => c.type === "text")?.text;
}

// ===========================================================================
// 1. df_handoff (3 tests)
// ===========================================================================

describe("df_handoff (MCP tool)", () => {
  it("happy path: existing handoff issue → upserts body, returns {issue, note_url, created:false}", async () => {
    await withHandoffMcp(async (client, gh) => {
      // Existing handoff issue #200 — body has an agent-context block already
      // (so spliceAgentContextBlock has something to splice into). The same
      // setIssueViewDefault config covers BOTH slot-1 (Phase C explicit-issue
      // capture) AND slot-2 (Phase F pre-PATCH drift check), so the drift
      // assertion in handoff-verb.ts passes.
      gh.setIssueViewDefault(
        issueView({ number: 200, body: bodyWithBlock() }),
      );

      const result = await client.callTool({
        name: "df_handoff",
        arguments: { note: NOTE, issue: "200" },
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        issue: string;
        note_url: string;
        created: boolean;
      };
      expect(structured).toEqual({
        issue: "200",
        // The PATCH path uses `#<issue>` as the noteUrl (handoff-verb.ts: the
        // CLI lacks the issue's html_url at PATCH-return time and bash's
        // analog echoes `#$ISSUE`).
        note_url: "#200",
        created: false,
      });

      const text = firstText(result);
      expect(text).toBeDefined();
      expect(text).toMatch(/updated handoff issue #200/);

      // The PATCH actually fired — body-file edit landed on #200.
      expect(
        gh.calls().some((c) => c.startsWith("gh issue edit 200 --body-file")),
      ).toBe(true);
    });
  });

  it("error path: missing agent-context markers → isError + marker-error message", async () => {
    await withHandoffMcp(async (client) => {
      // No agent-context markers anywhere in the note. The verb (Phase A)
      // refuses before any gh call. The SDK wraps the HandoffError throw
      // into { isError: true, content: [{type: "text", text: <message>}] }.
      const result = await client.callTool({
        name: "df_handoff",
        arguments: { note: "this note has no markers", issue: "42" },
      });

      expect(result.isError).toBe(true);
      const text = firstText(result);
      expect(text).toBeDefined();
      // Phase A's HandoffError message names the missing markers.
      expect(text).toMatch(/agent-context markers/);
    });
  });

  it("argv hygiene: issue=\"0\" → isError with the 'positive integer' refusal", async () => {
    await withHandoffMcp(async (client) => {
      // requireIssueNumber rejects "0" before any gh I/O fires (the tool
      // validates the optional issue arg via requireIssueNumber as soon as
      // it's present — see src/mcp/tools/handoff.ts).
      const result = await client.callTool({
        name: "df_handoff",
        arguments: { note: NOTE, issue: "0" },
      });

      expect(result.isError).toBe(true);
      const text = firstText(result);
      expect(text).toBeDefined();
      expect(text).toMatch(/positive integer/);
    });
  });

  it("reuse:true threads the #319 Fix C override through the MCP layer", async () => {
    const staleNote = `${MARK_O}\n_Updated: 2026-05-25 by old session_\n\nwhy: x\n${MARK_C}`;
    // Without reuse → the staleness guard refuses (isError, no PATCH).
    await withHandoffMcp(async (client, gh) => {
      gh.setIssueViewDefault(issueView({ number: 42, body: bodyWithBlock() }));
      const result = await client.callTool({
        name: "df_handoff",
        arguments: { note: staleNote, issue: "42" },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/stale|--reuse|days before now/i);
      expect(
        gh.calls().some((c) => c.startsWith("gh issue edit 42 --body-file")),
      ).toBe(false);
    });
    // With reuse:true → the override threads to runHandoff and the PATCH fires.
    await withHandoffMcp(async (client, gh) => {
      gh.setIssueViewDefault(issueView({ number: 42, body: bodyWithBlock() }));
      const result = await client.callTool({
        name: "df_handoff",
        arguments: { note: staleNote, issue: "42", reuse: true },
      });
      expect(result.isError).toBeFalsy();
      expect(
        gh.calls().some((c) => c.startsWith("gh issue edit 42 --body-file")),
      ).toBe(true);
    });
  });
});

// ===========================================================================
// 2. df_accept (3 tests)
// ===========================================================================

describe("df_accept (MCP tool)", () => {
  it("happy path: open handoff issue → rehydrate data + assign + close; text rendered", async () => {
    await withHandoffMcp(async (client, gh) => {
      // Full 7-step chain config — see accept-verb.ts comment block:
      //   step 1: gh.issueView slot 1 (body-bearing) → default works for both
      //   step 4: gh.issueViewSlim slot 1 (pre-assign drift: no assignees,
      //                                    updatedAt matches default IssueView)
      //   step 5: gh.issueAssignMe
      //   step 6: gh.issueViewSlim slot 2 (post-assign verify: @me present)
      //   step 7: gh.issueClose
      gh.setIssueViewDefault(issueView({ number: 42, body: bodyWithBlock() }));
      gh.setIssueViewSlimSlot(1, slimView({ assignees: [] }));
      gh.setIssueViewSlimSlot(
        2,
        slimView({ assignees: [{ login: "alien8d" }] }),
      );

      const result = await client.callTool({
        name: "df_accept",
        arguments: { issue: "42" },
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        issue: string;
        state: string;
        title: string;
        linked_items: unknown[];
        note: string | null;
      };
      expect(structured.issue).toBe("42");
      expect(structured.title).toBe("Handoff: example");
      // Rehydrate is derived at step 3 (BEFORE assign + close), so the
      // captured state-line reflects the issue as we found it: open and
      // unassigned (on the stack). The actual close happens at step 7 and
      // doesn't re-derive the rehydrate snapshot.
      expect(structured.state).toMatch(/open/i);
      expect(Array.isArray(structured.linked_items)).toBe(true);
      // The note field carries the marker-bounded block from the body, or
      // null. With our bodyWithBlock fixture there IS a block.
      expect(structured.note).toBeTypeOf("string");

      // text content is the bash-compatible renderRehydrateText output.
      const text = firstText(result);
      expect(text).toBeDefined();
      // The ritual blurb / state line / title all appear in the rendered text.
      expect(text).toContain("Handoff: example");

      // Side effects: the atomic chain actually mutated state.
      expect(
        gh.calls().some((c) => c === "gh issue edit 42 --add-assignee @me"),
      ).toBe(true);
      expect(gh.calls().some((c) => c === "gh issue close 42")).toBe(true);
    });
  });

  it("error path: already-closed handoff issue → isError, no mutation", async () => {
    await withHandoffMcp(async (client, gh) => {
      gh.setIssueViewDefault(
        issueView({
          number: 88,
          state: "CLOSED",
          closedAt: "2026-05-29T10:00:00Z",
        }),
      );

      const result = await client.callTool({
        name: "df_accept",
        arguments: { issue: "88" },
      });

      expect(result.isError).toBe(true);
      const text = firstText(result);
      expect(text).toBeDefined();
      // accept-verb's closed-state refusal message ("…handoff was already
      // accepted…" / "…closed handoff…") — match the closed token loosely
      // because the exact phrasing lives in accept-verb.ts.
      expect(text).toMatch(/closed/i);
      // No mutation: assignment and close never fired.
      expect(
        gh.calls().some((c) => c === "gh issue edit 88 --add-assignee @me"),
      ).toBe(false);
      expect(gh.calls().some((c) => c === "gh issue close 88")).toBe(false);
    });
  });

  it("argv hygiene: issue=\"\" → isError ('issue is required for df_accept')", async () => {
    await withHandoffMcp(async (client) => {
      // requireIssueNumber("") returns `undefined` (empty == not supplied);
      // the tool then explicitly throws HandoffError("issue is required for
      // df_accept"). The Zod inputSchema accepts any string (including ""),
      // so we're testing the tool-layer guard, not the schema.
      const result = await client.callTool({
        name: "df_accept",
        arguments: { issue: "" },
      });

      expect(result.isError).toBe(true);
      const text = firstText(result);
      expect(text).toBeDefined();
      expect(text).toMatch(/issue is required/);
    });
  });
});

// ===========================================================================
// 3. df_rehydrate (3 tests)
// ===========================================================================

describe("df_rehydrate (MCP tool)", () => {
  it("explicit issue: returns structuredContent + rendered text; no mutation", async () => {
    await withHandoffMcp(async (client, gh) => {
      gh.setIssueViewDefault(issueView({ number: 42, body: bodyWithBlock() }));

      const result = await client.callTool({
        name: "df_rehydrate",
        arguments: { issue: "42" },
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        issue: string;
        state: string;
        title: string;
        linked_items: unknown[];
        note: string | null;
      };
      expect(structured.issue).toBe("42");
      expect(structured.title).toBe("Handoff: example");
      // OPEN issue with no assignees → "open (unassigned — on the stack)".
      expect(structured.state).toMatch(/open/);

      const text = firstText(result);
      expect(text).toBeDefined();
      expect(text).toContain("Handoff: example");

      // /rehydrate is read-only — no assignment, no close, no body edit.
      expect(
        gh.calls().some((c) => c === "gh issue edit 42 --add-assignee @me"),
      ).toBe(false);
      expect(gh.calls().some((c) => c === "gh issue close 42")).toBe(false);
      expect(
        gh.calls().some((c) => c.startsWith("gh issue edit 42 --body-file")),
      ).toBe(false);
    });
  });

  it("no-arg tier-1 hit: resolves to most-recent open+@me handoff", async () => {
    await withHandoffMcp(async (client, gh) => {
      // Tier-1 list: one open handoff assigned to @me. The verb sorts
      // descending by updatedAt and picks slot[0] → #151.
      gh.setIssueListSlot(1, [
        listItem({
          number: 151,
          title: "my open one",
          assignees: [{ login: "alien8d" }],
          updatedAt: "2026-05-30T00:00:00Z",
        }),
      ]);
      // Then deriveRehydrateData calls issueView(151) — body-bearing slot 1.
      gh.setIssueViewDefault(
        issueView({
          number: 151,
          title: "my open one",
          assignees: [{ login: "alien8d" }],
          body: bodyWithBlock(),
        }),
      );

      const result = await client.callTool({
        name: "df_rehydrate",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        issue: string;
        title: string;
      };
      expect(structured.issue).toBe("151");
      expect(structured.title).toBe("my open one");

      // Confirm tier-1 call sequence: the verb queried open+@me FIRST.
      expect(
        gh
          .calls()
          .some((c) => c.startsWith("gh issue list --state open --assignee @me")),
      ).toBe(true);
      // No tier-2 query — tier-1 hit short-circuits.
      expect(
        gh.calls().some((c) => c.startsWith("gh issue list --state closed")),
      ).toBe(false);
    });
  });

  it("live-state-fails-hard: gh.issueView throws → isError", async () => {
    await withHandoffMcp(async (client, gh) => {
      // Configure gh.issueView slot 1 to throw — deriveRehydrateData hits
      // this and re-raises (per the explicit-issue path's "if it fails,
      // surface a HandoffError" contract). The SDK wraps the throw as
      // isError.
      gh.setIssueViewSlot(1, new Error("gh issue view failed (stubbed)"));

      const result = await client.callTool({
        name: "df_rehydrate",
        arguments: { issue: "42" },
      });

      expect(result.isError).toBe(true);
      const text = firstText(result);
      expect(text).toBeDefined();
      // The thrown HandoffError surfaces in the wrapped content. The
      // rehydrate-verb explicit-issue path is a thin wrapper around
      // deriveRehydrateData, which raises with the issue ref on the
      // wholesale issueView failure path — match on `#42` so we know
      // the failure is the one we stubbed, not an unrelated throw.
      expect(text).toContain("#42");
    });
  });
});

// ===========================================================================
// 4. df_handoffs (2 tests)
// ===========================================================================

describe("df_handoffs (MCP tool)", () => {
  it("with rows: returns structured rows[] + bash-compatible rendered text", async () => {
    await withHandoffMcp(async (client, gh) => {
      // Two items on the stack — runHandoffs sorts ascending by updatedAt
      // (oldest first).
      gh.setIssueListDefault([
        listItem({
          number: 10,
          title: "first one",
          updatedAt: "2026-05-28T00:00:00Z",
        }),
        listItem({
          number: 11,
          title: "second one",
          updatedAt: "2026-05-29T00:00:00Z",
        }),
      ]);

      const result = await client.callTool({
        name: "df_handoffs",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        rows: Array<{
          issue_number: number;
          title: string;
          age: string;
          linked_count: number;
          linked_display: string;
        }>;
      };
      expect(structured.rows).toHaveLength(2);
      // Ascending sort by updatedAt → #10 (2026-05-28) before #11 (2026-05-29).
      expect(structured.rows[0]!.issue_number).toBe(10);
      expect(structured.rows[1]!.issue_number).toBe(11);
      expect(structured.rows[0]!.title).toBe("first one");
      // Both list items have empty bodies → linked_count is 0.
      expect(structured.rows[0]!.linked_count).toBe(0);
      expect(structured.rows[0]!.linked_display).toBe("none");

      const text = firstText(result);
      expect(text).toBeDefined();
      expect(text).toContain("Handoff stack (oldest → newest):");
      expect(text).toContain("#10");
      expect(text).toContain("#11");
      // Footer ritual line that runHandoffs emits.
      expect(text).toContain("/accept <issue>");
    });
  });

  it("empty list: rows=[] + text mentions 'stack is empty'", async () => {
    await withHandoffMcp(async (client, gh) => {
      gh.setIssueListDefault([]);

      const result = await client.callTool({
        name: "df_handoffs",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { rows: unknown[] };
      expect(structured.rows).toEqual([]);

      const text = firstText(result);
      expect(text).toBeDefined();
      expect(text).toMatch(/stack is empty/i);
    });
  });
});
