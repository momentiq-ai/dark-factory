// MCP resources — cycle5 Phase 1 step 4.
//
// Registers the URI-addressable read-only resource surface the cycle5
// spec defines under "Resources" (Phase 1 — local stdio):
//
//   df://repo/cycles                       cycle index (JSON)
//   df://repo/cycle/{cycle_id}             structured cycle doc (JSON)
//   df://repo/adrs                         ADR index (JSON)
//   df://repo/adr/{adr_id}                 structured ADR (JSON)
//   df://repo/findings/{commit_sha}        per-commit findings (JSON)
//   df://repo/runs/recent                  recent telemetry events (JSON)
//   df://repo/config/critics               parsed config (JSON)
//   df://repo/audit-log                    bypass + review audit (NDJSON)
//   df://repo/principles                   PRINCIPLES.md (text/markdown)
//
// Cycle5 explicitly notes that **Phase 1 stdio does NOT support
// `resources/subscribe`** — clients are expected to poll if they need
// freshness on rapidly-changing data. We honor that by simply not
// registering subscribe handlers; the SDK reports the resource as
// non-subscribable in tools/list and clients adapt.
//
// Two of the URIs (`runs/recent`, `audit-log`) accept optional query
// strings (`?limit=N`, `?since=ISO8601`) that the spec writes as RFC
// 6570 templates. We register the base URI here and parse the query
// string off the requested URL in the read handler — simpler than
// fighting the SDK's template machinery for a single optional param,
// and the spec is silent on template-vs-flat URI registration.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

import { readTelemetryEvents } from "../evidence/audit-trail.js";
import { resolveArtifactDir, telemetryPath } from "../paths.js";
import { loadAgentReviewConfig } from "../policy/config.js";

import { listAdrDocs, readAdrDoc } from "./adr/parser.js";
import { listCycleDocs, readCycleDoc } from "./cycle-doc/parser.js";
import { mapArtifactForFindings } from "./tools/findings.js";
import { readArtifact } from "../report.js";
import { resolveCommit } from "../git.js";

export interface RegisterResourcesOptions {
  cwd?: string;
}

function resolveRoot(opts?: RegisterResourcesOptions): string {
  return resolve(opts?.cwd ?? process.cwd());
}

// Common URI prefix for all DF resources. Choosing the `df://` scheme
// (rather than `file://`) so clients can route DF reads cleanly even
// when an agent is composing multiple MCP servers.
const DF_REPO_PREFIX = "df://repo";

function jsonContent(uri: string, value: unknown): {
  uri: string;
  mimeType: string;
  text: string;
} {
  return {
    uri,
    mimeType: "application/json",
    text: JSON.stringify(value, null, 2),
  };
}

function markdownContent(uri: string, text: string): {
  uri: string;
  mimeType: string;
  text: string;
} {
  return { uri, mimeType: "text/markdown", text };
}

function ndjsonContent(uri: string, events: readonly unknown[]): {
  uri: string;
  mimeType: string;
  text: string;
} {
  return {
    uri,
    mimeType: "application/x-ndjson",
    text: events.map((e) => JSON.stringify(e)).join("\n"),
  };
}

// ---- Cycle docs ----------------------------------------------------

async function readCyclesIndex(cwd: string): Promise<{
  cycles: Awaited<ReturnType<typeof listCycleDocs>>;
}> {
  return { cycles: await listCycleDocs(cwd) };
}

// ---- ADRs ----------------------------------------------------------

async function readAdrsIndex(cwd: string): Promise<{
  adrs: Awaited<ReturnType<typeof listAdrDocs>>;
}> {
  return { adrs: await listAdrDocs(cwd) };
}

// ---- Findings ------------------------------------------------------

async function readFindingsForCommit(
  cwd: string,
  commitInput: string,
): Promise<ReturnType<typeof mapArtifactForFindings> | null> {
  let loaded;
  try {
    loaded = await loadAgentReviewConfig({ cwd });
  } catch {
    return null;
  }
  let sha: string;
  try {
    sha = await resolveCommit(commitInput, cwd);
  } catch {
    return null;
  }
  const artifact = await readArtifact(loaded, sha);
  if (!artifact) return null;
  return mapArtifactForFindings(artifact);
}

// ---- Recent runs ---------------------------------------------------

interface RecentRunsView {
  readonly events: readonly unknown[];
  readonly total_scanned: number;
  readonly limit: number;
}

async function readRecentRuns(
  cwd: string,
  limit: number,
): Promise<RecentRunsView> {
  let loaded;
  try {
    loaded = await loadAgentReviewConfig({ cwd });
  } catch {
    return { events: [], total_scanned: 0, limit };
  }
  const artifactDir = await resolveArtifactDir(loaded);
  const path = telemetryPath(artifactDir);
  const events = readTelemetryEvents(path);
  // Newest-first: telemetry is appended chronologically; reverse + slice.
  const recent = events.slice().reverse().slice(0, limit);
  return { events: recent, total_scanned: events.length, limit };
}

// ---- Audit log -----------------------------------------------------

async function readAuditLog(
  cwd: string,
  since: string | null,
): Promise<unknown[]> {
  let loaded;
  try {
    loaded = await loadAgentReviewConfig({ cwd });
  } catch {
    return [];
  }
  const artifactDir = await resolveArtifactDir(loaded);
  const path = telemetryPath(artifactDir);
  const events = readTelemetryEvents(path);
  if (!since) return events;
  // Lexicographic ISO8601 ordering — strings sort identically to dates
  // when in YYYY-MM-DDTHH:MM:SS.sssZ form (which telemetry writes).
  return events.filter((e) => typeof e.ts === "string" && e.ts >= since);
}

// ---- Config -------------------------------------------------------

async function readConfigCritics(cwd: string): Promise<unknown> {
  try {
    const loaded = await loadAgentReviewConfig({ cwd });
    return loaded.config;
  } catch {
    return null;
  }
}

// ---- Principles ----------------------------------------------------

function readPrinciples(cwd: string): string | null {
  const path = resolve(cwd, "docs", "PRINCIPLES.md");
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

// ---- Registration --------------------------------------------------

export function registerResources(
  server: McpServer,
  opts: RegisterResourcesOptions = {},
): void {
  // df://repo/cycles — static index of cycle docs.
  server.registerResource(
    "cycles-index",
    `${DF_REPO_PREFIX}/cycles`,
    {
      title: "Cycle docs index",
      description:
        "All cycle docs under docs/roadmap/cycles/, each with id, " +
        "title, status, owner?, target?. Same data as df_cycle_list.",
      mimeType: "application/json",
    },
    async (uri) => {
      const cwd = resolveRoot(opts);
      return { contents: [jsonContent(uri.toString(), await readCyclesIndex(cwd))] };
    },
  );

  // df://repo/cycle/{cycle_id} — templated single-cycle read.
  server.registerResource(
    "cycle",
    new ResourceTemplate(`${DF_REPO_PREFIX}/cycle/{cycle_id}`, {
      list: async () => {
        const cwd = resolveRoot(opts);
        const cycles = await listCycleDocs(cwd);
        return {
          resources: cycles.map((c) => ({
            uri: `${DF_REPO_PREFIX}/cycle/${c.id}`,
            name: c.title,
            description: `Cycle ${c.id} (${c.status})`,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "Cycle doc (by id)",
      description:
        "Structured cycle doc — { id, frontmatter, sections }. " +
        "Same data as df_cycle_read.",
      mimeType: "application/json",
    },
    async (uri, { cycle_id }) => {
      const cwd = resolveRoot(opts);
      const id = Array.isArray(cycle_id) ? cycle_id[0] : cycle_id;
      const doc = id ? await readCycleDoc(cwd, id) : null;
      if (!doc) {
        // The SDK's read-resource contract treats an empty content
        // array as "this URI resolves to nothing"; throwing is the
        // path that surfaces as an error on the client side.
        throw new Error(`cycle "${id}" not found under docs/roadmap/cycles/`);
      }
      return { contents: [jsonContent(uri.toString(), doc)] };
    },
  );

  // df://repo/adrs — static ADR index.
  server.registerResource(
    "adrs-index",
    `${DF_REPO_PREFIX}/adrs`,
    {
      title: "ADRs index",
      description:
        "All ADRs under docs/ADR/, each with id, title, status, " +
        "date. Same data as df_adr_list.",
      mimeType: "application/json",
    },
    async (uri) => {
      const cwd = resolveRoot(opts);
      return { contents: [jsonContent(uri.toString(), await readAdrsIndex(cwd))] };
    },
  );

  // df://repo/adr/{adr_id} — templated single-ADR read.
  server.registerResource(
    "adr",
    new ResourceTemplate(`${DF_REPO_PREFIX}/adr/{adr_id}`, {
      list: async () => {
        const cwd = resolveRoot(opts);
        const adrs = await listAdrDocs(cwd);
        return {
          resources: adrs.map((a) => ({
            uri: `${DF_REPO_PREFIX}/adr/${a.id}`,
            name: a.title,
            description: `ADR ${a.id} (${a.status})`,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "ADR (by id)",
      description:
        "Structured ADR — { id, frontmatter, body, status, " +
        "supersedes? }. Same data as df_adr_read.",
      mimeType: "application/json",
    },
    async (uri, { adr_id }) => {
      const cwd = resolveRoot(opts);
      const id = Array.isArray(adr_id) ? adr_id[0] : adr_id;
      const doc = id ? await readAdrDoc(cwd, id) : null;
      if (!doc) {
        throw new Error(`ADR "${id}" not found under docs/ADR/`);
      }
      return { contents: [jsonContent(uri.toString(), doc)] };
    },
  );

  // df://repo/findings/{commit_sha} — templated per-commit findings.
  server.registerResource(
    "findings",
    new ResourceTemplate(`${DF_REPO_PREFIX}/findings/{commit_sha}`, {
      // List is intentionally undefined-as-noop: enumerating every
      // SHA with a stored artifact could explode in size on busy
      // repos. The `df://repo/runs/recent` resource is the
      // discoverable index of recent commits.
      list: undefined,
    }),
    {
      title: "Findings (by commit)",
      description:
        "Narrowed findings for a commit — { commit, critics: [...] }. " +
        "Same data as df_findings.",
      mimeType: "application/json",
    },
    async (uri, { commit_sha }) => {
      const cwd = resolveRoot(opts);
      const sha = Array.isArray(commit_sha) ? commit_sha[0] : commit_sha;
      const out = sha ? await readFindingsForCommit(cwd, sha) : null;
      if (!out) {
        throw new Error(
          `no review artifact for "${sha}"; run \`df review --commit ${sha}\` first.`,
        );
      }
      return { contents: [jsonContent(uri.toString(), out)] };
    },
  );

  // df://repo/runs/recent — recent telemetry events. Optional
  // ?limit=N query param; default 25.
  //
  // The SDK matches static URIs exactly (query strings are not
  // stripped during dispatch) AND its ResourceTemplate with `{?limit}`
  // does NOT match the base URI when limit is absent (verified
  // empirically; see step-4 test history). So we register BOTH:
  //   - static URI `df://repo/runs/recent` for the no-query case
  //   - ResourceTemplate `df://repo/runs/recent{?limit}` for the
  //     ?limit=N case
  // Both route through the same handler logic via `handleRunsRecent`.
  async function handleRunsRecent(
    uri: URL,
    limitRaw: string | string[] | undefined,
  ) {
    const cwd = resolveRoot(opts);
    const rawLimit = Array.isArray(limitRaw) ? limitRaw[0] : limitRaw;
    const parsed = rawLimit ? parseInt(rawLimit, 10) : NaN;
    const limit = Number.isFinite(parsed)
      ? Math.max(1, Math.min(500, parsed))
      : 25;
    const view = await readRecentRuns(cwd, limit);
    return { contents: [jsonContent(uri.toString(), view)] };
  }
  server.registerResource(
    "runs-recent",
    `${DF_REPO_PREFIX}/runs/recent`,
    {
      title: "Recent runs",
      description:
        "Recent telemetry events from .git/agent-reviews/_runs.ndjson. " +
        "Accepts `?limit=N` (default 25, max 500).",
      mimeType: "application/json",
    },
    async (uri) => handleRunsRecent(uri, undefined),
  );
  server.registerResource(
    "runs-recent-limited",
    new ResourceTemplate(`${DF_REPO_PREFIX}/runs/recent{?limit}`, {
      list: undefined, // base URI is already listed via the static registration above.
    }),
    {
      title: "Recent runs (with limit)",
      description: "Same as df://repo/runs/recent; routes ?limit=N reads.",
      mimeType: "application/json",
    },
    async (uri, vars) => handleRunsRecent(uri, vars["limit"]),
  );

  // df://repo/config/critics — parsed .agent-review/config.json (full).
  // The TOOL surface narrows to { critics, aggregation, prompts }; the
  // RESOURCE surface returns the whole loaded config so clients
  // navigating via URIs can see policy, git, validation, etc. without
  // needing to chain calls.
  server.registerResource(
    "config-critics",
    `${DF_REPO_PREFIX}/config/critics`,
    {
      title: "Parsed agent-review config",
      description:
        "Full parsed .agent-review/config.json — every top-level " +
        "field (critics, aggregation, git, policy, context, " +
        "validation, security, etc.).",
      mimeType: "application/json",
    },
    async (uri) => {
      const cwd = resolveRoot(opts);
      const cfg = await readConfigCritics(cwd);
      if (cfg === null) {
        throw new Error("failed to load .agent-review/config.json");
      }
      return { contents: [jsonContent(uri.toString(), cfg)] };
    },
  );

  // df://repo/audit-log — NDJSON dump of telemetry. Optional
  // ?since=ISO8601 query param. Same double-registration pattern as
  // runs/recent above — see comment there for rationale.
  async function handleAuditLog(
    uri: URL,
    sinceRaw: string | string[] | undefined,
  ) {
    const cwd = resolveRoot(opts);
    const since =
      typeof sinceRaw === "string"
        ? sinceRaw
        : Array.isArray(sinceRaw)
          ? (sinceRaw[0] ?? null)
          : null;
    const events = await readAuditLog(cwd, since);
    return { contents: [ndjsonContent(uri.toString(), events)] };
  }
  server.registerResource(
    "audit-log",
    `${DF_REPO_PREFIX}/audit-log`,
    {
      title: "Audit log",
      description:
        ".git/agent-reviews/_runs.ndjson — bypass + review audit " +
        "entries. Accepts `?since=ISO8601` to filter newer entries.",
      mimeType: "application/x-ndjson",
    },
    async (uri) => handleAuditLog(uri, undefined),
  );
  server.registerResource(
    "audit-log-since",
    new ResourceTemplate(`${DF_REPO_PREFIX}/audit-log{?since}`, {
      list: undefined,
    }),
    {
      title: "Audit log (since)",
      description: "Same as df://repo/audit-log; routes ?since=… reads.",
      mimeType: "application/x-ndjson",
    },
    async (uri, vars) => handleAuditLog(uri, vars["since"]),
  );

  // df://repo/principles — text/markdown PRINCIPLES.md.
  server.registerResource(
    "principles",
    `${DF_REPO_PREFIX}/principles`,
    {
      title: "Engineering principles",
      description:
        "docs/PRINCIPLES.md verbatim (incl. YAML frontmatter when " +
        "present). Read once at session start to understand the " +
        "guardrails for changes.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const cwd = resolveRoot(opts);
      const text = readPrinciples(cwd);
      if (text === null) {
        throw new Error("docs/PRINCIPLES.md not found.");
      }
      return { contents: [markdownContent(uri.toString(), text)] };
    },
  );
}
