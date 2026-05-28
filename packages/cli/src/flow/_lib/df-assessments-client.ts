// df-assessments-client — shared read path for `df flow *` subcommands.
//
// Reads `momentiq-ai/df-assessments` (the LA git-as-database store) via the
// gh CLI's Contents API. All subcommands share this client so the gh-api
// rate budget is tracked in one place and the in-memory path-keyed cache
// reuses parse results within a single CLI invocation.
//
// Trust boundary (Decision 5, cycle 6 spec): df-assessments repo read
// access via ambient `gh` CLI auth. No installation-id RBAC here — the
// hosted runtime's aggregation service owns that surface. This CLI is the
// developer-tool path, analogous to `gh` on any source repo.

import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  AgentTrustLedgerRow,
  AgentTrustSummary,
  AssessmentArtifact,
  CostTrackingRow,
  RecurrenceEvent,
} from "../types.js";

export const DEFAULT_TENANT = "sage3c";
export const DEFAULT_REPO = "momentiq-ai/df-assessments";

// ---------------------------------------------------------------------------
// Low-level fetcher interface. Production uses `GhApiFetcher` (shell to
// `gh api`); tests inject `FixtureFetcher` (read local files).

export interface RawFile {
  text: string;
  sha: string;
}

export interface RawDirEntry {
  name: string;
  sha: string;
  type: "file" | "dir";
}

export interface RawFetcher {
  // Returns null on 404 (file missing); throws on auth / network errors.
  getFile(path: string): Promise<RawFile | null>;
  // Returns null on 404 (dir missing); throws on auth / network errors.
  listDir(path: string): Promise<RawDirEntry[] | null>;
}

export class FetchError extends Error {
  constructor(
    message: string,
    public readonly code: "auth" | "rate-limit" | "network" | "unknown",
  ) {
    super(message);
    this.name = "FetchError";
  }
}

// ---------------------------------------------------------------------------
// GhApiFetcher — shells out to `gh api`.

interface GhApiResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runGh(args: string[]): Promise<GhApiResult> {
  return new Promise<GhApiResult>((resolvePromise, rejectPromise) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
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
      resolvePromise({
        exitCode: code === null ? -1 : code,
        stdout,
        stderr,
      });
    });
  });
}

function classifyGhError(stderr: string): FetchError {
  const lower = stderr.toLowerCase();
  if (lower.includes("rate limit") || lower.includes("api rate")) {
    return new FetchError(`gh API rate limit: ${stderr.trim()}`, "rate-limit");
  }
  if (
    lower.includes("authentication") ||
    lower.includes("401") ||
    lower.includes("login")
  ) {
    return new FetchError(`gh API auth error: ${stderr.trim()}`, "auth");
  }
  return new FetchError(`gh API error: ${stderr.trim()}`, "network");
}

function isNotFound(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return lower.includes("404") || lower.includes("not found");
}

export class GhApiFetcher implements RawFetcher {
  constructor(private readonly repo: string = DEFAULT_REPO) {}

  async getFile(path: string): Promise<RawFile | null> {
    const endpoint = `repos/${this.repo}/contents/${path}`;
    const r = await runGh(["api", endpoint, "--jq", "{content, sha}"]);
    if (r.exitCode !== 0) {
      if (isNotFound(r.stderr)) return null;
      throw classifyGhError(r.stderr);
    }
    let body: { content?: string; sha?: string };
    try {
      body = JSON.parse(r.stdout) as { content?: string; sha?: string };
    } catch (err) {
      throw new FetchError(
        `gh API returned non-JSON for ${path}: ${(err as Error).message}`,
        "unknown",
      );
    }
    const sha = body.sha;
    const content = body.content;
    if (typeof sha !== "string" || typeof content !== "string") {
      throw new FetchError(
        `gh API response for ${path} missing sha or content`,
        "unknown",
      );
    }
    // Contents API returns the content base64-encoded with newlines every 60
    // chars. Node's Buffer.from(..., "base64") tolerates the newlines.
    const text = Buffer.from(content, "base64").toString("utf8");
    return { text, sha };
  }

  async listDir(path: string): Promise<RawDirEntry[] | null> {
    const endpoint = `repos/${this.repo}/contents/${path}`;
    const r = await runGh([
      "api",
      endpoint,
      "--jq",
      "[.[] | {name, sha, type}]",
    ]);
    if (r.exitCode !== 0) {
      if (isNotFound(r.stderr)) return null;
      throw classifyGhError(r.stderr);
    }
    let entries: Array<{ name?: string; sha?: string; type?: string }>;
    try {
      entries = JSON.parse(r.stdout) as Array<{
        name?: string;
        sha?: string;
        type?: string;
      }>;
    } catch (err) {
      throw new FetchError(
        `gh API returned non-JSON listing for ${path}: ${(err as Error).message}`,
        "unknown",
      );
    }
    if (!Array.isArray(entries)) {
      throw new FetchError(
        `gh API returned non-array listing for ${path}`,
        "unknown",
      );
    }
    const out: RawDirEntry[] = [];
    for (const e of entries) {
      if (typeof e.name !== "string" || typeof e.sha !== "string") continue;
      const type = e.type === "dir" ? "dir" : "file";
      out.push({ name: e.name, sha: e.sha, type });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// FixtureFetcher — reads from a local directory rooted at <fixtureRoot>.
// Path layout under the root mirrors the gh Contents API path: a file
// fetched as `store/tenant/sage3c/pr/2310.json` resolves to
// `<fixtureRoot>/store/tenant/sage3c/pr/2310.json`. Used by unit tests.

export class FixtureFetcher implements RawFetcher {
  constructor(private readonly fixtureRoot: string) {}

  private fakeSha(path: string): string {
    // Deterministic but coarse — tests don't exercise SHA semantics yet.
    return `fixture-${path.replace(/[^a-zA-Z0-9]/g, "_")}`;
  }

  async getFile(path: string): Promise<RawFile | null> {
    const fullPath = resolve(this.fixtureRoot, path);
    try {
      const text = await readFile(fullPath, "utf8");
      return { text, sha: this.fakeSha(path) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async listDir(path: string): Promise<RawDirEntry[] | null> {
    const fullPath = resolve(this.fixtureRoot, path);
    try {
      const entries = await readdir(fullPath, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        sha: this.fakeSha(`${path}/${e.name}`),
        type: e.isDirectory() ? "dir" : "file",
      }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers for parsing the assessor's two file shapes.

function parseJsonStrict<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new FetchError(
      `failed to parse ${label}: ${(err as Error).message}`,
      "unknown",
    );
  }
}

function parseNdjson<T>(text: string, label: string): T[] {
  const lines = text.split("\n");
  const out: T[] = [];
  let lineNumber = 0;
  for (const raw of lines) {
    lineNumber++;
    const line = raw.trim();
    if (line === "") continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch (err) {
      throw new FetchError(
        `failed to parse ${label} line ${lineNumber}: ${(err as Error).message}`,
        "unknown",
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// DfAssessmentsClient — typed read API over a RawFetcher.
//
// In-memory path-keyed cache lives for the CLI invocation. Since each `df
// flow *` call exits the process when done, the cache's only job is to
// dedupe reads within one command (e.g. `trends` fetching N pr/*.json
// files — listDir + N getFile calls without re-fetching the dir between
// subsequent transforms).

interface CacheEntry {
  sha: string;
  // Lazily-parsed payload, stored as the raw text and a typed parser
  // reference. We don't memoize parsed payloads keyed by parser identity
  // because each path is parsed once per shape it has — text caching
  // captures the wire-cost saving, which is what gh-rate-limit cares about.
  text: string;
}

export class DfAssessmentsClient {
  private readonly fileCache = new Map<string, CacheEntry>();
  private readonly dirCache = new Map<string, RawDirEntry[]>();

  constructor(private readonly fetcher: RawFetcher) {}

  private async getFileText(path: string): Promise<string | null> {
    const cached = this.fileCache.get(path);
    if (cached !== undefined) return cached.text;
    const raw = await this.fetcher.getFile(path);
    if (raw === null) return null;
    this.fileCache.set(path, { sha: raw.sha, text: raw.text });
    return raw.text;
  }

  private async getDirEntries(path: string): Promise<RawDirEntry[] | null> {
    const cached = this.dirCache.get(path);
    if (cached !== undefined) return cached;
    const raw = await this.fetcher.listDir(path);
    if (raw === null) return null;
    this.dirCache.set(path, raw);
    return raw;
  }

  async getAssessment(
    tenant: string,
    prNumber: number,
  ): Promise<AssessmentArtifact | null> {
    const path = `store/tenant/${tenant}/pr/${prNumber}.json`;
    const text = await this.getFileText(path);
    if (text === null) return null;
    return parseJsonStrict<AssessmentArtifact>(text, path);
  }

  async listPrNumbers(tenant: string): Promise<number[]> {
    const path = `store/tenant/${tenant}/pr`;
    const entries = await this.getDirEntries(path);
    if (entries === null) return [];
    const out: number[] = [];
    for (const e of entries) {
      if (e.type !== "file") continue;
      const m = /^(\d+)\.json$/.exec(e.name);
      if (m === null) continue;
      const n = Number(m[1]);
      if (Number.isFinite(n)) out.push(n);
    }
    return out.sort((a, b) => a - b);
  }

  async getAgentTrustSummary(
    tenant: string,
  ): Promise<AgentTrustSummary | null> {
    const path = `store/tenant/${tenant}/agents-trust-summary.json`;
    const text = await this.getFileText(path);
    if (text === null) return null;
    return parseJsonStrict<AgentTrustSummary>(text, path);
  }

  async getAgentTrustLedger(tenant: string): Promise<AgentTrustLedgerRow[]> {
    const path = `store/tenant/${tenant}/agents-trust.ndjson`;
    const text = await this.getFileText(path);
    if (text === null) return [];
    return parseNdjson<AgentTrustLedgerRow>(text, path);
  }

  async getCostTracking(tenant: string): Promise<CostTrackingRow[]> {
    const path = `store/tenant/${tenant}/cost-tracking.ndjson`;
    const text = await this.getFileText(path);
    if (text === null) return [];
    return parseNdjson<CostTrackingRow>(text, path);
  }

  async getRecurrence(
    tenant: string,
    patternId: string,
  ): Promise<RecurrenceEvent[]> {
    const path = `store/tenant/${tenant}/recurrence/${patternId}.ndjson`;
    const text = await this.getFileText(path);
    if (text === null) return [];
    return parseNdjson<RecurrenceEvent>(text, path);
  }
}

// Convenience factory for production code paths.
export function makeGhClient(repo: string = DEFAULT_REPO): DfAssessmentsClient {
  return new DfAssessmentsClient(new GhApiFetcher(repo));
}
