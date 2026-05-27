// `df mcp` CLI wiring test — cycle5 Phase 1 step 1.
//
// Spawns the compiled `df mcp` binary as a subprocess and:
//   - Confirms `df --help` advertises the mcp subcommand.
//   - Confirms `df mcp --help` prints subcommand-specific help to stdout
//     and exits 0 (without starting the transport).
//   - Drives the real stdio transport with a raw JSON-RPC initialize
//     request and asserts:
//       (a) the negotiated protocolVersion is 2025-06-18
//       (b) stdout contains only JSON-RPC frames (one per line) —
//           no stdout pollution by warmup/init/diagnostic messages
//       (c) the process exits 0 on stdin EOF (no zombie process)
//
// The companion in-process test (tests/mcp/server.test.ts) covers the
// server's behaviour at the SDK level; this test pins the CLI process
// boundary that real MCP clients actually wire up.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(HERE, "..", "..", "dist", "cli.js");

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runDf(args: string[], stdinInput?: string): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => rejectPromise(err));
    child.on("close", (code) => {
      resolvePromise({ exitCode: code === null ? -1 : code, stdout, stderr });
    });
    if (stdinInput !== undefined) {
      child.stdin?.end(stdinInput);
    } else {
      child.stdin?.end();
    }
  });
}

describe("df CLI — Phase G (cycle5 MCP) subcommand wiring", () => {
  it("`df --help` advertises the mcp subcommand", async () => {
    const r = await runDf(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df mcp");
    expect(r.stdout).toMatch(/Model Context Protocol/);
  });

  it("`df mcp --help` prints subcommand-specific help and exits 0", async () => {
    const r = await runDf(["mcp", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/df mcp — start the Dark Factory Model Context Protocol/);
    expect(r.stdout).toMatch(/Pinned MCP protocol version: 2025-06-18/);
    // The help printer is the only stdout writer for `df mcp --help`;
    // ensure the global help wasn't ALSO printed (would have been a
    // stdout-pollution regression — see PHASE_G_SUBCOMMANDS comment in
    // src/cli.ts).
    expect(r.stdout).not.toMatch(/Subcommands \(Phase C —/);
  });

  it("`df mcp` close path fires onclose handler (cleanup is not dead code)", async () => {
    // Empty stdin → transport sees immediate EOF → onclose fires.
    // If the SDK ever stops chaining `onclose` callbacks (regression),
    // this test catches it because the diagnostic won't be emitted.
    const r = await runDf(["mcp"], "");
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("[df mcp] transport closed");
  });

  it("`df mcp` over stdio: initialize handshake returns protocolVersion 2025-06-18", async () => {
    const initRequest =
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":' +
      '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":' +
      '{"name":"df-cli-routing-test","version":"0.0.0"}}}';
    const initializedNotice = '{"jsonrpc":"2.0","method":"notifications/initialized"}';
    const toolsListRequest =
      '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}';
    const stdinInput =
      [initRequest, initializedNotice, toolsListRequest].join("\n") + "\n";

    const r = await runDf(["mcp"], stdinInput);

    expect(r.exitCode).toBe(0);

    // The transport speaks newline-delimited JSON-RPC. Both responses
    // must arrive as clean lines on stdout with no header or
    // diagnostic prefix.
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);

    const initResponse = JSON.parse(lines[0] ?? "") as {
      jsonrpc: string;
      id: number;
      result?: {
        protocolVersion?: string;
        serverInfo?: { name?: string };
        capabilities?: Record<string, unknown>;
      };
      error?: unknown;
    };
    expect(initResponse.jsonrpc).toBe("2.0");
    expect(initResponse.id).toBe(1);
    expect(initResponse.error).toBeUndefined();
    expect(initResponse.result?.protocolVersion).toBe("2025-06-18");
    expect(initResponse.result?.serverInfo?.name).toMatch(/dark-factory/);
    expect(initResponse.result?.capabilities).toBeDefined();

    const toolsResponse = JSON.parse(lines[1] ?? "") as {
      jsonrpc: string;
      id: number;
      result?: { tools?: Array<{ name: string }> };
    };
    expect(toolsResponse.id).toBe(2);
    // Pin the catalog by name through the subprocess transport too —
    // catches a regression where in-process tests pass but the real
    // stdio path serves a different catalog (e.g. a wiring error in
    // server.ts only present at the compiled-import boundary).
    expect((toolsResponse.result?.tools ?? []).map((t) => t.name).sort()).toEqual([
      "df_adr_list",
      "df_adr_read",
      "df_critics_config",
      "df_cycle_list",
      "df_cycle_read",
      "df_doctor",
      "df_findings",
      "df_gate_push",
      "df_show_run",
      "df_stats",
    ]);
  });
});
