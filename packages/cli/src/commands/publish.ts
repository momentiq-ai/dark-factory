// `df publish` — Cycle 331.1 verifiable-objectives Phase 2
// (momentiq-ai/dark-factory#207). Persist the `df verify` evidence bundle.
//
// In CI, after `df verify` (re)produces the diffHash-bound gate JSON +
// screenshots, `df publish` uploads them to Cerebe object storage and emits a
// `PublishedEvidence` pointer manifest (`{routeId → upload_id, diffHash}`,
// provenance `consumer-attested`) for the hosted worker (Phase 3) to join
// against `.darkfactory/objectives.yaml`.
//
// Degrade-and-pass (spec §5): when Cerebe is unconfigured (the air-gap / OSS
// baseline path — `CEREBE_API_URL`/`CEREBE_API_KEY` unset) or an upload fails,
// `df publish` emits a `status: "degraded"` manifest and still EXITS 0, so the
// merge verdict is never blocked by a storage outage. Exit non-zero only for a
// usage error (2) or a config/git error (1).
import { writeFileSync } from "node:fs";

import { loadAgentReviewConfig } from "../policy/config.js";
import { resolveCommit } from "../git.js";
import {
  CerebeStorage,
  resolveCerebeConfig,
  type CerebeConfig,
} from "../evidence/cerebe.js";
import {
  buildPublishManifest,
  collectPublishArtifacts,
  type EvidenceUploader,
} from "../evidence/publish.js";

export interface PublishIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

// Injection seams — defaulted to the real env + Cerebe client so the CLI
// dispatch passes none, while tests substitute a mock uploader + env.
export interface PublishDeps {
  env?: Record<string, string | undefined>;
  resolveCerebe?: (env: Record<string, string | undefined>) => CerebeConfig | null;
  makeUploader?: (config: CerebeConfig) => EvidenceUploader;
}

interface PublishOptions {
  commit: string;
  cwd: string;
  out: string | null;
}

const HELP = [
  "df publish — upload the `df verify` evidence bundle to Cerebe + emit pointers.",
  "",
  "Usage:",
  "  df publish [--commit <ref>] [--cwd <path>] [--out <file>]",
  "",
  "Reads the per-SHA quality-gate evidence `df verify` wrote (the diffHash-bound",
  "gate JSON + any UI screenshots), uploads each artifact to Cerebe object",
  "storage, and writes a `PublishedEvidence` pointer manifest (schemaVersion 1,",
  "provenance consumer-attested) the hosted worker joins against the objectives",
  "manifest.",
  "",
  "Cerebe is configured via the environment:",
  "  CEREBE_API_URL   Base URL of the Cerebe storage API (required to publish).",
  "  CEREBE_API_KEY   API key sent as the `X-API-Key` header (required).",
  "  CEREBE_PROJECT   Optional project scope (`X-Cerebe-Project` header).",
  "",
  "When Cerebe is not configured, or an upload fails, publish emits a",
  '`status: "degraded"` manifest and still exits 0 (degrade-and-pass) — the',
  "merge verdict is never blocked by a storage outage.",
  "",
  "Flags:",
  "  --commit <ref>  Commit ref (anything `git rev-parse` accepts; default HEAD).",
  "  --cwd <path>    Repository root to operate in (default: process cwd).",
  "  --out <file>    Write the manifest to <file> (default: stdout).",
  "  --help, -h      Show this message.",
  "",
  "Exit codes:",
  "  0  manifest emitted (complete OR degraded), or nothing to publish",
  "  1  config load failure or bad commit ref",
  "  2  usage / flag error",
  "",
].join("\n");

function parsePublishArgs(rest: string[]): PublishOptions | { error: string } {
  let commit = "HEAD";
  let cwd = process.cwd();
  let out: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a === "--commit" || a === "--cwd" || a === "--out") {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { error: `${a} requires a value.` };
      }
      if (a === "--commit") commit = next;
      else if (a === "--cwd") cwd = next;
      else out = next;
      i++;
      continue;
    }
    if (a.startsWith("--commit=")) {
      commit = a.slice("--commit=".length);
      continue;
    }
    if (a.startsWith("--cwd=")) {
      cwd = a.slice("--cwd=".length);
      continue;
    }
    if (a.startsWith("--out=")) {
      out = a.slice("--out=".length);
      continue;
    }
    return { error: `unknown flag or positional arg: ${a}` };
  }
  return { commit, cwd, out };
}

export async function cmdPublish(
  rest: string[],
  io: PublishIo,
  deps: PublishDeps = {},
): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    io.stdout(`${HELP}`);
    return 0;
  }
  const parsed = parsePublishArgs(rest);
  if ("error" in parsed) {
    io.stderr(`df publish: ${parsed.error}\nRun \`df publish --help\` for usage.\n`);
    return 2;
  }

  let loaded;
  try {
    loaded = await loadAgentReviewConfig({ cwd: parsed.cwd });
  } catch (err) {
    io.stderr(`df publish: ${(err as Error).message}\n`);
    return 1;
  }

  let sha: string;
  try {
    sha = await resolveCommit(parsed.commit, parsed.cwd);
  } catch (err) {
    io.stderr(`df publish: ${(err as Error).message}\n`);
    return 1;
  }
  const short = sha.slice(0, 12);

  let collected;
  try {
    collected = await collectPublishArtifacts(loaded, sha, parsed.cwd);
  } catch (err) {
    io.stderr(`df publish: failed to read evidence for ${short}: ${(err as Error).message}\n`);
    return 1;
  }
  if (collected === null) {
    io.stdout(
      `df publish: no quality-gate evidence found for ${short} — run \`df verify\` first; nothing to publish.\n`,
    );
    return 0;
  }

  const env = deps.env ?? process.env;
  const resolveCerebe = deps.resolveCerebe ?? resolveCerebeConfig;
  const makeUploader = deps.makeUploader ?? ((config: CerebeConfig) => new CerebeStorage(config));
  const cerebe = resolveCerebe(env);
  const uploader = cerebe ? makeUploader(cerebe) : null;

  const manifest = await buildPublishManifest({
    commit: sha,
    ...(collected.diffHash !== undefined ? { diffHash: collected.diffHash } : {}),
    ...(collected.gate !== undefined ? { gate: collected.gate } : {}),
    routes: collected.routes,
    uploader,
    sessionId: `df-publish:${short}`,
    userId: (env["CEREBE_USER_ID"] ?? "dark-factory").trim() || "dark-factory",
  });

  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (parsed.out !== null) {
    try {
      writeFileSync(parsed.out, serialized, "utf8");
    } catch (err) {
      io.stderr(`df publish: failed to write ${parsed.out}: ${(err as Error).message}\n`);
      return 1;
    }
    io.stdout(`df publish: wrote manifest to ${parsed.out}\n`);
  } else {
    io.stdout(serialized);
  }

  const uploaded =
    (manifest.gateEvidence ? 1 : 0) +
    Object.values(manifest.routes).reduce((n, r) => n + r.artifacts.length, 0);
  if (manifest.status === "degraded") {
    io.stderr(
      `df publish: status=degraded (${short}) — ${manifest.degradedReason ?? "unknown reason"}\n`,
    );
  } else {
    io.stderr(`df publish: status=complete (${short}) — ${uploaded} artifact(s) uploaded.\n`);
  }
  return 0;
}
