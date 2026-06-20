// Cycle 331.1 verifiable-objectives Phase 2 (momentiq-ai/dark-factory#207) —
// the publish orchestration behind `df publish`. After `df verify` produces the
// diffHash-bound evidence bundle in CI, publish uploads it to Cerebe object
// storage and emits a `PublishedEvidence` pointer manifest (`{routeId →
// upload_id, diffHash}`) the hosted worker (Phase 3) joins against the
// objectives manifest.
//
// Two layers, split for testability:
//   - `collectPublishArtifacts` — reads the per-SHA gate JSON + each route's
//     working-tree artifacts (UI screenshots) from disk.
//   - `buildPublishManifest` — uploads staged artifacts via an injected
//     uploader and assembles the manifest. Degrade-and-pass (spec §5): a null
//     uploader (Cerebe unconfigured) or any upload failure yields a `degraded`
//     manifest, never a thrown error — capture must not block the merge verdict.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";

import type {
  EvidenceArtifactPointer,
  EvidenceProvenance,
  PublishedEvidence,
  RouteEvidencePointer,
} from "@momentiq/dark-factory-schemas";

import type { LoadedConfig } from "../policy/config.js";
import type { CerebeUploadInput, CerebeUploadResult } from "./cerebe.js";
import { readQualityGateEvidence } from "./quality-gates.js";

// The minimal upload surface `buildPublishManifest` needs — `CerebeStorage`
// satisfies it, and tests inject a mock without any network.
export interface EvidenceUploader {
  uploadFile(input: CerebeUploadInput): Promise<CerebeUploadResult>;
}

// An artifact staged for upload: its diagnostic repo-relative path + the bytes.
export interface ArtifactSource {
  path: string;
  contentType: string;
  bytes: Uint8Array;
}

// A route's outcome + the file artifacts its producer wrote.
export interface RouteArtifacts {
  routeId: string;
  exitCode: number;
  sources: ArtifactSource[];
}

export interface BuildPublishManifestInput {
  commit: string;
  diffHash?: string;
  // The per-SHA `QualityGateEvidence` JSON, uploaded once.
  gate?: ArtifactSource;
  routes: RouteArtifacts[];
  // `null` ⇒ Cerebe unconfigured ⇒ degrade without uploading.
  uploader: EvidenceUploader | null;
  // CI-context identifiers for the multipart upload.
  sessionId: string;
  userId: string;
  provenance?: EvidenceProvenance; // default "consumer-attested"
}

// How many failed-artifact details to inline in `degradedReason` before
// truncating (the full count is always stated).
const MAX_DEGRADED_DETAILS = 3;

export async function buildPublishManifest(
  input: BuildPublishManifestInput,
): Promise<PublishedEvidence> {
  const provenance = input.provenance ?? "consumer-attested";

  // Air-gap / unconfigured: degrade-and-pass. Record route exit codes (still
  // useful as a structural outcome) but upload nothing.
  if (input.uploader === null) {
    return {
      schemaVersion: 1,
      commit: input.commit,
      provenance,
      status: "degraded",
      ...(input.diffHash !== undefined ? { diffHash: input.diffHash } : {}),
      routes: emptyRoutePointers(input.routes),
      degradedReason:
        "Cerebe not configured (CEREBE_API_URL / CEREBE_API_KEY unset) — evidence captured but not published.",
    };
  }

  const uploader = input.uploader;
  const failures: string[] = [];

  const tryUpload = async (source: ArtifactSource): Promise<EvidenceArtifactPointer | null> => {
    try {
      const r = await uploader.uploadFile({
        bytes: source.bytes,
        filename: basename(source.path),
        contentType: source.contentType,
        sessionId: input.sessionId,
        userId: input.userId,
      });
      return {
        path: source.path,
        uploadId: r.uploadId,
        sha256: r.sha256,
        contentType: r.contentType,
        sizeBytes: r.sizeBytes,
      };
    } catch (err) {
      failures.push(`${source.path}: ${(err as Error).message}`);
      return null;
    }
  };

  let gateEvidence: EvidenceArtifactPointer | undefined;
  if (input.gate) {
    gateEvidence = (await tryUpload(input.gate)) ?? undefined;
  }

  const routes: Record<string, RouteEvidencePointer> = {};
  for (const r of input.routes) {
    const artifacts: EvidenceArtifactPointer[] = [];
    for (const source of r.sources) {
      const ptr = await tryUpload(source);
      if (ptr) artifacts.push(ptr);
    }
    routes[r.routeId] = { routeId: r.routeId, exitCode: r.exitCode, artifacts };
  }

  const status = failures.length > 0 ? "degraded" : "complete";
  const degradedReason =
    failures.length > 0
      ? `Cerebe upload failed for ${failures.length} artifact(s): ${failures
          .slice(0, MAX_DEGRADED_DETAILS)
          .join("; ")}${failures.length > MAX_DEGRADED_DETAILS ? "; …" : ""}`
      : undefined;

  return {
    schemaVersion: 1,
    commit: input.commit,
    provenance,
    status,
    ...(gateEvidence !== undefined ? { gateEvidence } : {}),
    ...(input.diffHash !== undefined ? { diffHash: input.diffHash } : {}),
    routes,
    ...(degradedReason !== undefined ? { degradedReason } : {}),
  };
}

function emptyRoutePointers(routes: RouteArtifacts[]): Record<string, RouteEvidencePointer> {
  const out: Record<string, RouteEvidencePointer> = {};
  for (const r of routes) {
    out[r.routeId] = { routeId: r.routeId, exitCode: r.exitCode, artifacts: [] };
  }
  return out;
}

export interface CollectedArtifacts {
  gate?: ArtifactSource;
  routes: RouteArtifacts[];
  diffHash?: string;
}

// Read the per-SHA gate JSON + each route's working-tree artifacts. Returns
// `null` when no (current, non-stale) evidence exists for the commit — the
// "nothing to publish" case (`df verify` never ran, or ran for a different
// diff).
export async function collectPublishArtifacts(
  loaded: LoadedConfig,
  commit: string,
  cwd: string,
): Promise<CollectedArtifacts | null> {
  const { evidence, path: gatePath, stale } = await readQualityGateEvidence(loaded, commit);
  if (!evidence || stale || evidence.commit !== commit) return null;

  const gate: ArtifactSource = {
    path: toPosixRelative(gatePath, cwd),
    contentType: "application/json",
    bytes: readFileSync(gatePath),
  };

  // Map routeId → evidenceKind so we know which routes emit file artifacts.
  const routeTable = loaded.config.validation.verificationRoutes ?? [];
  const evidenceKindById = new Map(routeTable.map((r) => [r.id, r.evidenceKind]));

  const routes: RouteArtifacts[] = [];
  for (const [routeId, result] of Object.entries(evidence.gateResults ?? {})) {
    const sources =
      // The Playwright UI route is the only v1 route that writes separate file
      // artifacts (screenshots / ARIA) into the working tree; other kinds carry
      // their outcome in the gate JSON alone.
      evidenceKindById.get(routeId) === "playwright" ? readUiArtifacts(cwd, commit) : [];
    routes.push({ routeId, exitCode: result.exitCode, sources });
  }

  return {
    gate,
    routes,
    ...(evidence.diffHash !== undefined ? { diffHash: evidence.diffHash } : {}),
  };
}

// The Playwright UI route writes to `<repoRoot>/agent-reviews/quality-gates/
// ui/<sha>/...` (working tree; see skills/verify/producer/playwright-route.sh).
// Read every regular file under that tree, in a deterministic order.
function readUiArtifacts(cwd: string, commit: string): ArtifactSource[] {
  const root = resolve(cwd, "agent-reviews", "quality-gates", "ui", commit);
  if (!existsSync(root)) return [];
  const out: ArtifactSource[] = [];
  for (const abs of walkFiles(root)) {
    out.push({
      path: toPosixRelative(abs, cwd),
      contentType: contentTypeForPath(abs),
      bytes: readFileSync(abs),
    });
  }
  return out;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out.sort();
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".html": "text/html",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

export function contentTypeForPath(p: string): string {
  return CONTENT_TYPES[extname(p).toLowerCase()] ?? "application/octet-stream";
}

// Repo-relative, POSIX-separated path for the manifest (stable across OSes).
function toPosixRelative(abs: string, cwd: string): string {
  return relative(cwd, abs).split(sep).join("/");
}
