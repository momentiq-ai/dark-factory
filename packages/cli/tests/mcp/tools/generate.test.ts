// Integration tests for df_cycle_doc_generate + df_adr_generate —
// cycle5 Phase 1 step 8.
//
// The "SOTA" sampling flow:
//   server.registerTool('df_cycle_doc_generate', ...) — when invoked,
//   the tool calls server.server.createMessage(...) which sends a
//   sampling/createMessage request OVER MCP to the CLIENT, which
//   then runs an LLM (in production: Opus 4.7 / Cursor / etc.) and
//   returns the response. The server validates + writes the file.
//
// In tests we set a request handler on the Client side that returns
// a synthetic LLM response. The Client must also declare `sampling`
// in its capabilities so the server's createMessage call doesn't
// get rejected as "client does not support sampling."

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createMcpServer } from "../../../src/mcp/server.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "df-generate-"));
  spawnSync("git", ["init", "-q", "-b", "main", root]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface OpenOptions {
  /** LLM response text the synthetic client returns for sampling. */
  samplingResponseText?: string;
  /** Model name to report in the response. */
  samplingModel?: string;
  /** Whether the client declares sampling capability (default true). */
  withSamplingCap?: boolean;
  /** Whether to auto-accept elicitation gates. */
  acceptElicitation?: boolean;
}

async function openSamplingClient(opts: OpenOptions = {}) {
  const server = createMcpServer({ cwd: root });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "df-generate-test", version: "0.0.0" },
    {
      capabilities: {
        ...(opts.withSamplingCap !== false ? { sampling: {} } : {}),
        elicitation: {},
      },
    },
  );
  // Mock the LLM: respond to sampling/createMessage with the
  // configured text + a synthetic model name.
  // The SDK refuses to register a sampling handler on a client that
  // hasn't declared the `sampling` capability — so we conditionally
  // register based on `withSamplingCap`. Skipping registration is
  // exactly the "client doesn't support sampling" scenario the test
  // for graceful failure needs.
  if (opts.withSamplingCap !== false) {
    client.setRequestHandler(CreateMessageRequestSchema, () => ({
      model: opts.samplingModel ?? "claude-test-stub",
      role: "assistant" as const,
      content: { type: "text" as const, text: opts.samplingResponseText ?? "" },
      stopReason: "endTurn" as const,
    }));
  }
  // Mock elicitation: auto-accept or auto-decline per opts.
  client.setRequestHandler(ElicitRequestSchema, () => ({
    action: opts.acceptElicitation === false ? ("decline" as const) : ("accept" as const),
    content: { proceed: opts.acceptElicitation !== false },
  }));
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

const VALID_CYCLE_DOC = `---
title: "Cycle 42 — The answer"
status: "draft"
owner: "@pj"
started: "2026-05-27"
target: "TBD"
closed: null
---

# cycle42 — The answer

## Scope

Ship the integration test fixture.

## Goals

- Verify sampling
- Verify writing
- Verify validation

## Non-goals

- Boil the ocean
- Cure cancer

## Architecture

Test fixture writes here.

## Security

Trust boundary unchanged.

## Testing

Vitest integration.

## Implementation plan

1. Wire test.
2. Run.

## Risks

Schema drift.

## Exit criteria

Tests pass.

## Open questions

None.
`;

const VALID_ADR = `# ADR 2026-06-test — Test ADR decision

- **Status:** Proposed
- **Date:** 2026-06-15
- **Deciders:** PJ
- **Scope:** This test.

## Context

We need a fixture ADR for the integration test.

## Decision

Test ADR decision (one-sentence statement).

## Alternatives considered

- Keep raw markdown
- Embed pyodide

## Consequences

The integration test passes.
`;

describe("df_cycle_doc_generate (cycle5 Phase 1 step 8)", () => {
  it("calls sampling, validates the LLM response, writes the file, returns path + token usage", async () => {
    const { client, close } = await openSamplingClient({
      samplingResponseText: VALID_CYCLE_DOC,
      samplingModel: "claude-opus-4-7-1m",
    });
    try {
      const result = await client.callTool({
        name: "df_cycle_doc_generate",
        arguments: {
          cycle_id: "cycle42",
          title: "The answer",
          scope: "Ship the integration test fixture.",
        },
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as
        | {
            path: string;
            sampling_token_usage: {
              prompt_estimate: number;
              completion_estimate: number;
              model: string;
              stop_reason?: string;
            };
          }
        | undefined;
      expect(structured?.path).toMatch(/docs\/roadmap\/cycles\/cycle42-the-answer\.md$/);
      expect(structured?.sampling_token_usage.model).toBe("claude-opus-4-7-1m");
      expect(structured?.sampling_token_usage.prompt_estimate).toBeGreaterThan(0);
      expect(structured?.sampling_token_usage.completion_estimate).toBeGreaterThan(0);
      expect(structured?.sampling_token_usage.stop_reason).toBe("endTurn");

      // File written verbatim from the LLM response.
      const written = readFileSync(structured!.path, "utf8");
      expect(written).toBe(VALID_CYCLE_DOC);
    } finally {
      await close();
    }
  });

  it("refuses to overwrite an existing target file", async () => {
    // Pre-create the file the tool would otherwise write.
    spawnSync("mkdir", ["-p", join(root, "docs", "roadmap", "cycles")]);
    const existing = join(root, "docs", "roadmap", "cycles", "cycle42-the-answer.md");
    writeFileSync(existing, "# already here\n", "utf8");

    const { client, close } = await openSamplingClient({
      samplingResponseText: VALID_CYCLE_DOC,
    });
    try {
      const result = await client.callTool({
        name: "df_cycle_doc_generate",
        arguments: {
          cycle_id: "cycle42",
          title: "The answer",
          scope: "Ship the integration test fixture.",
        },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>).find(
        (c) => c.type === "text",
      )?.text;
      expect(text).toMatch(/already exists|Refusing to overwrite/);
      // Existing file content untouched.
      expect(readFileSync(existing, "utf8")).toBe("# already here\n");
    } finally {
      await close();
    }
  });

  it("rejects absolute target_path and `..`-traversal", async () => {
    const { client, close } = await openSamplingClient({
      samplingResponseText: VALID_CYCLE_DOC,
    });
    try {
      const absoluteResult = await client.callTool({
        name: "df_cycle_doc_generate",
        arguments: {
          cycle_id: "cycle42",
          title: "The answer",
          scope: "x",
          target_path: "/etc/evil.md",
        },
      });
      expect(absoluteResult.isError).toBe(true);
      expect(
        (absoluteResult.content as Array<{ type: string; text?: string }>).find(
          (c) => c.type === "text",
        )?.text,
      ).toMatch(/cwd-relative/);

      const traversalResult = await client.callTool({
        name: "df_cycle_doc_generate",
        arguments: {
          cycle_id: "cycle42",
          title: "The answer",
          scope: "x",
          target_path: "../../etc/evil.md",
        },
      });
      expect(traversalResult.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("returns isError when the LLM response fails validation", async () => {
    const { client, close } = await openSamplingClient({
      // No frontmatter, no h1, no required sections → all 3 validation
      // checks should fire.
      samplingResponseText: "just some text the LLM hallucinated",
    });
    try {
      const result = await client.callTool({
        name: "df_cycle_doc_generate",
        arguments: {
          cycle_id: "cycle42",
          title: "The answer",
          scope: "x",
        },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>).find(
        (c) => c.type === "text",
      )?.text;
      expect(text).toMatch(/failed validation/);
      expect(text).toMatch(/missing YAML frontmatter/);
      // The raw response is included so the agent can re-prompt.
      expect(text).toContain("just some text the LLM hallucinated");
    } finally {
      await close();
    }
  });

  it("surfaces a sampling failure when the client doesn't support sampling", async () => {
    const { client, close } = await openSamplingClient({ withSamplingCap: false });
    try {
      const result = await client.callTool({
        name: "df_cycle_doc_generate",
        arguments: {
          cycle_id: "cycle42",
          title: "The answer",
          scope: "x",
        },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>).find(
        (c) => c.type === "text",
      )?.text;
      expect(text).toMatch(/sampling\/createMessage failed/);
    } finally {
      await close();
    }
  });
});

describe("df_adr_generate (cycle5 Phase 1 step 8)", () => {
  it("calls sampling, validates the ADR, writes the file", async () => {
    const { client, close } = await openSamplingClient({
      samplingResponseText: VALID_ADR,
      samplingModel: "claude-opus-4-7-1m",
    });
    try {
      const result = await client.callTool({
        name: "df_adr_generate",
        arguments: {
          adr_id: "2026-06-test",
          decision: "Test ADR decision",
          context: "We need a fixture for testing.",
          alternatives: ["Keep raw markdown", "Embed pyodide"],
        },
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as
        | { path: string; sampling_token_usage: { model: string } }
        | undefined;
      expect(structured?.path).toMatch(/docs\/ADR\/2026-06-test\.md$/);
      expect(structured?.sampling_token_usage.model).toBe("claude-opus-4-7-1m");
      expect(existsSync(structured!.path)).toBe(true);
      expect(readFileSync(structured!.path, "utf8")).toBe(VALID_ADR);
    } finally {
      await close();
    }
  });

  it("returns isError when the ADR response lacks required bullet metadata", async () => {
    const { client, close } = await openSamplingClient({
      samplingResponseText: "# ADR x — y\n\nNo bullets, no sections.\n",
    });
    try {
      const result = await client.callTool({
        name: "df_adr_generate",
        arguments: {
          adr_id: "2026-06-broken",
          decision: "Test ADR",
          context: "ctx",
          alternatives: ["a"],
        },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>).find(
        (c) => c.type === "text",
      )?.text;
      expect(text).toMatch(/Status:.*bullet|missing required section/);
    } finally {
      await close();
    }
  });
});
