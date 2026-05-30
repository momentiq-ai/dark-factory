// Thin gh-api shell-out used by every `df flow` subcommand. We shell out to
// the user's authenticated `gh` CLI (rather than vendoring an HTTP client +
// token resolution) because:
//   - `df` already ambient-trusts `gh` for the Phase C subcommands.
//   - df-assessments is a private repo; the CLI's trust boundary is the
//     developer's repo read access (Cycle 11 Decision 5 — acknowledged
//     LA-acceptable limitation).
//   - Forwarding through `gh` inherits the user's existing OAuth/PAT cache
//     and any 2FA setup, which an in-process HTTP client would have to
//     duplicate.
//
// All file reads are issued against the Contents API, which returns
// `{ content, encoding: "base64" }` for files and an array for directories.
// We decode base64 here so call-sites work with raw text. 404 is a normal
// outcome ("no assessment yet for PR N") and returns null; the caller maps
// that to exit code 2 ("data not found"). Other non-zero exits from `gh` are
// treated as transport failures and surfaced as DfFlowGhError, which the
// caller maps to exit code 3.

import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";

import type { ContentsListEntry } from "./types.js";

export const DF_ASSESSMENTS_REPO = "momentiq-ai/df-assessments";

export class DfFlowGhError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "DfFlowGhError";
  }
}

interface GhContentsFileResponse {
  type?: string;
  encoding?: string;
  content?: string;
  size?: number;
}

export interface GhFetcher {
  fetchFileText(path: string, ref?: string): string | null;
  fetchDir(path: string, ref?: string): ContentsListEntry[] | null;
}

interface SpawnGh {
  (args: string[]): { status: number | null; stdout: string; stderr: string };
}

const defaultSpawnGh: SpawnGh = (args) => {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    // gh writes 4xx error bodies to stderr and respects this size; the
    // default 1MB buffer is the cap that matters for the directory
    // listings — sage3c's `pr/` listing is well under that today.
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw new DfFlowGhError(
      `gh CLI invocation failed before running: ${result.error.message}`,
      result.status ?? -1,
      result.stderr ?? "",
    );
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

// gh's 4xx output goes to stderr and looks like:
//   "gh: Not Found (HTTP 404)\n"
// or, for resource paths that aren't path-mapped:
//   "{\"message\":\"Not Found\",...}" (status 1)
// We sniff both shapes; the test suite covers each.
function isNotFound(stderr: string): boolean {
  if (/HTTP 404/i.test(stderr)) return true;
  if (/"message":"Not Found"/i.test(stderr)) return true;
  return false;
}

function decodeBase64(content: string): string {
  // gh Contents API returns base64 with line breaks; Buffer accepts both.
  return Buffer.from(content, "base64").toString("utf8");
}

export function createGhFetcher(spawn: SpawnGh = defaultSpawnGh): GhFetcher {
  return {
    fetchFileText(path: string, ref = "main"): string | null {
      const apiPath = `repos/${DF_ASSESSMENTS_REPO}/contents/${path}?ref=${ref}`;
      const r = spawn(["api", apiPath]);
      if (r.status !== 0) {
        if (isNotFound(r.stderr)) return null;
        throw new DfFlowGhError(
          `gh api ${apiPath} failed (exit ${r.status ?? "?"}): ${r.stderr.trim()}`,
          r.status ?? -1,
          r.stderr,
        );
      }
      let parsed: GhContentsFileResponse;
      try {
        parsed = JSON.parse(r.stdout) as GhContentsFileResponse;
      } catch (err) {
        throw new DfFlowGhError(
          `gh api ${apiPath} returned non-JSON: ${(err as Error).message}`,
          0,
          r.stdout.slice(0, 256),
        );
      }
      if (typeof parsed.content !== "string") {
        // Either an unexpected payload shape or a directory; both are
        // contract violations for a file path.
        throw new DfFlowGhError(
          `gh api ${apiPath} returned no file content (type=${parsed.type ?? "?"})`,
          0,
          "",
        );
      }
      return decodeBase64(parsed.content);
    },
    fetchDir(path: string, ref = "main"): ContentsListEntry[] | null {
      const apiPath = `repos/${DF_ASSESSMENTS_REPO}/contents/${path}?ref=${ref}`;
      const r = spawn(["api", apiPath]);
      if (r.status !== 0) {
        if (isNotFound(r.stderr)) return null;
        throw new DfFlowGhError(
          `gh api ${apiPath} failed (exit ${r.status ?? "?"}): ${r.stderr.trim()}`,
          r.status ?? -1,
          r.stderr,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.stdout);
      } catch (err) {
        throw new DfFlowGhError(
          `gh api ${apiPath} returned non-JSON: ${(err as Error).message}`,
          0,
          r.stdout.slice(0, 256),
        );
      }
      if (!Array.isArray(parsed)) {
        throw new DfFlowGhError(
          `gh api ${apiPath} returned ${typeof parsed}, expected directory array`,
          0,
          "",
        );
      }
      return parsed as ContentsListEntry[];
    },
  };
}

// Parses ndjson (newline-delimited JSON) safely, skipping blank lines and
// surfacing a parse error with the offending line number so operators can
// pin a malformed write to the row that produced it.
export function parseNdjson<T>(text: string, label: string): T[] {
  const rows: T[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch (err) {
      throw new Error(
        `${label}: failed to parse line ${i + 1}: ${(err as Error).message}`,
      );
    }
  }
  return rows;
}
