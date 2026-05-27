// CLI wiring for `df mcp` — cycle5 Phase 1 stdio server.
//
// Stdout discipline: the stdio MCP transport OWNS process.stdout for
// JSON-RPC frames. Anything written to stdout that isn't a frame
// corrupts the channel and makes the client drop the connection. So:
//
//   - `df mcp --help` writes to stdout BEFORE any transport connect
//     (safe: no transport is wired yet).
//   - Once cmdMcp connects the StdioServerTransport, every diagnostic
//     must go to stderr. The transport itself handles JSON-RPC frames
//     on stdout.
//
// The lifecycle is intentionally minimal — the SDK transport closes
// itself on stdin EOF (the parent agent process exiting), which
// resolves the keep-alive promise and lets cmdMcp return.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpServer } from "./server.js";

export function printMcpHelp(): void {
  process.stdout.write(
    [
      "df mcp — start the Dark Factory Model Context Protocol server (stdio).",
      "",
      "Usage:",
      "  df mcp                       Start the MCP server on stdio.",
      "  df mcp --help                Print this help and exit.",
      "",
      "The server speaks MCP JSON-RPC on stdin/stdout. Diagnostics are",
      "written to stderr so they don't corrupt the transport.",
      "",
      "Pinned MCP protocol version: 2025-06-18 (cycle5). Bump deliberately",
      "with a companion ADR. Clients drive version negotiation; the server",
      "negotiates down to any version in @modelcontextprotocol/sdk's",
      "SUPPORTED_PROTOCOL_VERSIONS.",
      "",
      "Wire into Claude Code (or any MCP client) via .mcp.json:",
      "",
      "  {",
      '    "mcpServers": {',
      '      "dark-factory": {',
      '        "command": "npx",',
      '        "args": ["df", "mcp"]',
      "      }",
      "    }",
      "  }",
      "",
      "See docs/roadmap/cycles/cycle5-mcp-server.md for the full",
      "implementation plan; this skeleton ships the initialize handshake",
      "and empty tools/resources/prompts catalogs. Subsequent steps wire",
      "individual catalog entries.",
      "",
    ].join("\n"),
  );
}

export async function cmdMcp(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    printMcpHelp();
    return 0;
  }

  const server = createMcpServer();
  const transport = new StdioServerTransport();

  // Bail on transport-level errors instead of letting the process spin.
  // Errors go to stderr; stdout is reserved for the transport's frames.
  //
  // The SDK's `Protocol.connect` chains rather than replaces our
  // onclose/onerror handlers (Protocol captures the pre-existing
  // callbacks into locals, then composes them with its own), so
  // setting them BEFORE calling `server.connect(transport)` is the
  // supported way to add a user-level lifecycle hook.
  //
  // CRITICAL: the SDK's StdioServerTransport (at @modelcontextprotocol/
  // sdk@1.29.0) listens for stdin's `data` and `error` events but NOT
  // `end`. That means on stdin EOF — the normal way an MCP client
  // signals disconnect when the agent process exits — the transport
  // never calls its own `close()`, so `onclose` never fires. The
  // process happens to exit cleanly because nothing keeps the event
  // loop alive once stdin's data emitter stops, but `await
  // server.close()` below would be dead code without an explicit EOF
  // hook here. The "[df mcp] transport closed" diagnostic in stderr
  // is load-bearing — its absence in the subprocess test would mean
  // the SDK changed behaviour OR our EOF hook regressed.
  await new Promise<void>((resolvePromise, rejectPromise) => {
    transport.onclose = (): void => {
      process.stderr.write("[df mcp] transport closed\n");
      resolvePromise();
    };
    transport.onerror = (err: Error): void => {
      process.stderr.write(`[df mcp] transport error: ${err.message}\n`);
      rejectPromise(err);
    };
    process.stdin.once("end", () => {
      // Trigger the SDK transport's close path so the chained
      // onclose handler above runs in the SDK's expected order.
      void transport.close();
    });
    server.connect(transport).then(
      () => {
        // Connect succeeded; the transport now keeps the event loop
        // alive until stdin closes or the client disconnects.
      },
      (err: unknown) => {
        rejectPromise(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });

  await server.close();
  return 0;
}
