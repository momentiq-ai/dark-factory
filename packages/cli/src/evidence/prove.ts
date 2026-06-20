// Cycle 331.1 verifiable-objectives — the closeout proof readout behind
// `df prove` (momentiq-ai/dark-factory#207). Joins each declared objective
// (`.darkfactory/objectives.yaml`) against the local evidence that attests it —
// route exit codes (`df verify`), critic verdicts (`df review`) — resolving every
// binding to proven / pending / failed and assembling a `BoundProofRecord`.
//
// Two layers, split for testability:
//   - `buildProofRecord` — the pure join (no disk, no git); takes already-loaded
//     inputs, returns the record. The trichotomy + worst-of rollup live here.
//   - `collectProofInputs` — reads the manifest + gate evidence + review artifact
//     from disk for a commit.
//
// Trust boundary: this readout is agent-attested, evidence-backed — the agent
// authored both the code and the objectives. It is stronger than free-text "done"
// (every status is DERIVED from diffHash-bound artifacts, not asserted) but is NOT
// independent verification. See the design spec (§2).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import {
  parseObjectivesManifest,
  type BoundEvidenceRef,
  type BoundProofRecord,
  type CriticStatus,
  type EvidenceBinding,
  type Objective,
  type ObjectiveProof,
  type ProofStatus,
  type ProofSummary,
  type ReviewVerdict,
} from "@momentiq/dark-factory-schemas";

import { loadAgentReviewConfig } from "../policy/config.js";
import { commitDiff, diffHash, resolveCommit, safeParentOrThrow } from "../git.js";
import { readQualityGateEvidence } from "./quality-gates.js";
import { loadForCommit } from "../lib/show-status-core.js";

// Route/test evidence for one routeId: just the exit code (the gate file's
// diffHash is carried once on `ProofInputs.evidenceDiffHash`).
export interface RouteEvidenceInput {
  exitCode: number;
}

// Critic evidence for one criticId, lifted from the per-SHA review artifact.
export interface CriticEvidenceInput {
  status: CriticStatus;
  verdict?: ReviewVerdict;
}

export interface ProofInputs {
  commit: string;
  // HEAD's gated diff hash — the binding target. Absent on a git error.
  headDiffHash?: string;
  objectives: Objective[];
  // routeId/test-ref → exit code (from the per-SHA QualityGateEvidence).
  gateResults: Record<string, RouteEvidenceInput>;
  // The diffHash stamped on that gate evidence (absent = SHA-only).
  evidenceDiffHash?: string;
  // criticId → verdict/status (from the per-SHA ReviewArtifact).
  criticResults: Record<string, CriticEvidenceInput>;
  // routeId/criticId → Cerebe upload id; enrichment present only after publish.
  uploadIds?: Record<string, string>;
}

const STATUS_RANK: Record<ProofStatus, number> = { proven: 0, pending: 1, failed: 2 };

function worstOf(statuses: ProofStatus[]): ProofStatus {
  let worst: ProofStatus = "proven";
  for (const s of statuses) {
    if (STATUS_RANK[s] > STATUS_RANK[worst]) worst = s;
  }
  return worst;
}

function resolveRouteLike(
  kind: "route" | "test",
  ref: string,
  inputs: ProofInputs,
): BoundEvidenceRef {
  const uploadId = inputs.uploadIds?.[ref];
  const base = { kind, ref, ...(uploadId ? { uploadId } : {}) };
  const r = inputs.gateResults[ref];
  if (!r) {
    return { ...base, status: "pending", detail: "no route evidence — run `df verify`" };
  }
  if (r.exitCode !== 0) {
    return { ...base, status: "failed", detail: `route exited ${r.exitCode}` };
  }
  const bound =
    inputs.evidenceDiffHash !== undefined &&
    inputs.headDiffHash !== undefined &&
    inputs.evidenceDiffHash === inputs.headDiffHash;
  if (bound) {
    return { ...base, status: "proven", detail: "exit 0, diffHash-bound" };
  }
  return {
    ...base,
    status: "pending",
    detail: "exit 0 but evidence not bound to HEAD's diff (stale or SHA-only)",
  };
}

function resolveCritic(criticId: string, inputs: ProofInputs): BoundEvidenceRef {
  const uploadId = inputs.uploadIds?.[criticId];
  const base = { kind: "critic" as const, ref: criticId, ...(uploadId ? { uploadId } : {}) };
  const c = inputs.criticResults[criticId];
  if (!c) {
    return { ...base, status: "pending", detail: "awaiting critic verdict — fleet has not run on HEAD" };
  }
  if (c.verdict === "APPROVED") {
    return { ...base, status: "proven", detail: "critic APPROVED" };
  }
  if (c.verdict === "CHANGES_REQUESTED") {
    return { ...base, status: "failed", detail: "critic CHANGES_REQUESTED" };
  }
  return { ...base, status: "pending", detail: `critic ${c.status}, no verdict yet` };
}

function resolveBinding(b: EvidenceBinding, inputs: ProofInputs): BoundEvidenceRef {
  switch (b.kind) {
    case "route":
      return resolveRouteLike("route", b.routeId, inputs);
    case "test":
      return resolveRouteLike("test", b.ref, inputs);
    case "critic":
      return resolveCritic(b.criticId, inputs);
  }
}

// Pure join: objectives × evidence → BoundProofRecord. `generatedAt` is supplied
// by the caller (keeps this deterministic + testable).
export function buildProofRecord(inputs: ProofInputs, generatedAt: string): BoundProofRecord {
  const objectives: ObjectiveProof[] = inputs.objectives.map((o) => {
    const bindings = o.attestedBy.map((b) => resolveBinding(b, inputs));
    // An objective with no bindings is declared-but-unbound → pending, never
    // silently proven. Otherwise it's the worst of its bindings.
    const status: ProofStatus =
      bindings.length === 0 ? "pending" : worstOf(bindings.map((b) => b.status));
    return { id: o.id, text: o.text, enforced: o.enforced, status, bindings };
  });

  const summary: ProofSummary = { proven: 0, pending: 0, failed: 0, total: objectives.length };
  for (const o of objectives) summary[o.status] += 1;

  return {
    schemaVersion: 1,
    commit: inputs.commit,
    ...(inputs.headDiffHash !== undefined ? { diffHash: inputs.headDiffHash } : {}),
    provenance: "consumer-attested",
    generatedAt,
    objectives,
    summary,
  };
}

export interface CollectedProofInputs {
  inputs: ProofInputs;
  resolvedSha: string;
}

const OBJECTIVES_MANIFEST_REL = ".darkfactory/objectives.yaml";

// Read the objectives manifest + gate evidence + review artifact from disk for a
// commit. Returns `null` when no manifest is present (nothing to prove). Throws
// (caller → exit 1) on a malformed manifest or unreadable config — a real error
// in the PR's own diff.
export async function collectProofInputs(
  cwd: string,
  commit: string,
): Promise<CollectedProofInputs | null> {
  const manifestPath = resolve(cwd, OBJECTIVES_MANIFEST_REL);
  if (!existsSync(manifestPath)) return null;
  const manifest = parseObjectivesManifest(
    parseYaml(readFileSync(manifestPath, "utf8")),
    OBJECTIVES_MANIFEST_REL,
  );

  const loaded = await loadAgentReviewConfig({ cwd });
  const sha = await resolveCommit(commit, cwd);

  // HEAD's gated diff hash (the binding target). Fail-soft: a transient git
  // error leaves it undefined → route bindings degrade to pending, never
  // false-proven.
  let headDiffHash: string | undefined;
  try {
    const parent = await safeParentOrThrow(sha, cwd);
    headDiffHash = diffHash(await commitDiff(parent, sha, cwd));
  } catch {
    headDiffHash = undefined;
  }

  // Route/test evidence.
  const gateResults: Record<string, RouteEvidenceInput> = {};
  let evidenceDiffHash: string | undefined;
  const { evidence } = await readQualityGateEvidence(loaded, sha);
  if (evidence && evidence.commit === sha) {
    evidenceDiffHash = evidence.diffHash;
    for (const [routeId, res] of Object.entries(evidence.gateResults ?? {})) {
      gateResults[routeId] = { exitCode: res.exitCode };
    }
  }

  // Critic evidence (the per-SHA ReviewArtifact). Absent → empty → critic
  // bindings resolve to pending.
  const criticResults: Record<string, CriticEvidenceInput> = {};
  const { artifact } = await loadForCommit(cwd, sha);
  if (artifact) {
    for (const c of artifact.criticResults) {
      criticResults[c.criticId] = {
        status: c.status,
        ...(c.verdict !== undefined ? { verdict: c.verdict } : {}),
      };
    }
  }

  return {
    inputs: {
      commit: sha,
      ...(headDiffHash !== undefined ? { headDiffHash } : {}),
      objectives: manifest.objectives,
      gateResults,
      ...(evidenceDiffHash !== undefined ? { evidenceDiffHash } : {}),
      criticResults,
    },
    resolvedSha: sha,
  };
}
