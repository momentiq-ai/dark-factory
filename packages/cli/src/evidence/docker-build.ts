// Service #4 (Per-SHA Evidence Store) extension — Docker build evidence.
//
// Closes the verification gap from `dark-factory-platform#141`. The local
// + W3 critic adapter sandboxes cannot reach a Docker daemon socket, so
// the critic literally cannot execute `docker build` to verify a
// Dockerfile-touching PR. The consumer repo's pre-push hook runs a
// `scripts/check-dockerfile.sh` shim on the host that already has docker,
// captures the build result, and stamps it into
// `<artifactDir>/_dockerbuild-evidence.json`. This module reads that
// file and shapes it into the `DockerBuildEvidence[]` array attached to
// `ReviewPacket.dockerBuildEvidence` by the packet builder.
//
// The contract is intentionally permissive:
//   - file absent             → return undefined, status quo behavior
//   - JSON parse failure      → return undefined + diag-log, fail-open
//   - field validation errors → skip the bad record, keep the good ones
//
// Rationale for fail-open: this evidence is an OPTIONAL upgrade to the
// critic's signal. A malformed shim file should never block a review
// (the critic still works, it just falls back to the existing
// requiresHumanJudgment posture). The hard error path belongs in the
// shim itself (DFP-side), not here.
//
// Critic-finding routing for each record is performed by the prompt
// builder (`src/prompt.ts`) on the basis of `exitCode`:
//   - exitCode === 0  → instruct critic to suppress "can't run docker
//                       build" findings for this Dockerfile path
//   - exitCode !== 0  → instruct critic to surface a [blocker] finding
//                       citing the build failure

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { LoadedConfig } from "../policy/config.js";
import { resolveArtifactDir } from "../paths.js";
import type { DockerBuildEvidence } from "@momentiq/dark-factory-schemas";

// Canonical filename written by the consumer's `scripts/check-dockerfile.sh`
// shim. Exported so test fixtures and hosted-runtime callers don't
// re-string-literal this filename and silently drift apart from the shim.
export const DOCKER_BUILD_EVIDENCE_FILENAME = "_dockerbuild-evidence.json";

// Resolve the canonical path for the docker-build evidence file. Lives
// next to the per-SHA artifact tree (`<artifactRoot>/<artifactDir>/...`)
// so the existing artifact-cleanup machinery sweeps it without any
// extra wiring. NOT per-SHA — there is exactly ONE evidence file per
// pre-push invocation; the shim recomputes it on each push.
export async function dockerBuildEvidencePath(
  loaded: LoadedConfig,
): Promise<string> {
  return resolve(await resolveArtifactDir(loaded), DOCKER_BUILD_EVIDENCE_FILENAME);
}

// Read and normalize the shim-produced evidence file. Returns the
// validated evidence records OR undefined when the file is missing /
// malformed / contains no valid records. Never throws on IO or parse
// errors — failure is silent by design (see module docstring).
export async function readDockerBuildEvidence(
  loaded: LoadedConfig,
): Promise<DockerBuildEvidence[] | undefined> {
  const path = await dockerBuildEvidencePath(loaded);
  if (!existsSync(path)) return undefined;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  // Shim contract supports both the single-object form (one Dockerfile,
  // the common case) and the array form (multiple Dockerfiles in the
  // pushed range — e.g., a monorepo touch). Normalize to an array
  // before validation so the downstream pipeline only sees one shape.
  const records: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

  const validated: DockerBuildEvidence[] = [];
  for (const rec of records) {
    const v = validateDockerBuildEvidence(rec);
    if (v) validated.push(v);
  }

  return validated.length > 0 ? validated : undefined;
}

// Structural validation of a single record. Field names and types match
// the DFP-side shim spec (#141). Returns the canonicalized record on
// success, or undefined on any required-field failure. Optional fields
// are coerced when present + valid, dropped when absent or invalid.
//
// We intentionally do NOT use a heavy schema validator (zod, ajv) here
// — this is read on the hot path (every review) and the contract is
// narrow enough that explicit field checks are clearer than a runtime
// schema interpreter, and faster to fail-open on unexpected input.
function validateDockerBuildEvidence(
  rec: unknown,
): DockerBuildEvidence | undefined {
  if (!rec || typeof rec !== "object") return undefined;
  const r = rec as Record<string, unknown>;

  const schemaVersion = stringField(r["schemaVersion"]);
  const dockerfile = stringField(r["dockerfile"]);
  const context = stringField(r["context"]);
  const exitCode = numberField(r["exitCode"]);
  const timestamp = stringField(r["timestamp"]);

  if (
    schemaVersion === undefined ||
    dockerfile === undefined ||
    context === undefined ||
    exitCode === undefined ||
    timestamp === undefined
  ) {
    return undefined;
  }

  const out: DockerBuildEvidence = {
    schemaVersion,
    dockerfile,
    context,
    exitCode,
    timestamp,
  };

  const imageSha = stringField(r["imageSha"]);
  if (imageSha !== undefined) out.imageSha = imageSha;
  const imageSize = numberField(r["imageSize"]);
  if (imageSize !== undefined) out.imageSize = imageSize;
  const buildLogPath = stringField(r["buildLogPath"]);
  if (buildLogPath !== undefined) out.buildLogPath = buildLogPath;

  return out;
}

function stringField(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function numberField(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
