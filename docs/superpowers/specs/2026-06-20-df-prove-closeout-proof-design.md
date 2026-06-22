---
title: "df prove — closeout proof readout for verifiable objectives"
date: 2026-06-20
status: draft
authors: [PJ, Claude Code]
related_repos: [dark-factory, dark-factory-platform]
parent_spec: dark-factory-platform/docs/superpowers/specs/2026-06-19-verifiable-objectives-evidence-design.md
related_issues: [momentiq-ai/dark-factory#207]
cycle: "331.1"
---

# df prove — closeout proof readout

## 1. Problem & motivation

Verifiable-objectives Phase 1–2 built the **passive** half of "proof": evidence is
captured (`df verify`), persisted to Cerebe (`df publish`), joined into a bound proof
record (Phase 3 worker, not yet built), and surfaced for *someone who goes looking* —
the dashboard (Phase 4) and an MCP query (Phase 5).

The **active** half is missing. When the local coding agent finishes, nothing
**computes** "did every declared objective get its bound evidence?" and nothing
**requires** the agent to present that as its closeout. The agent free-texts "done."
We have the *discipline* (the `verification-before-completion` skill — "evidence before
assertions"), but no **primitive** in the `df` tooling that turns the discipline into a
machine-checked readout the agent must cite.

`df prove` is that primitive: the local mirror of the dashboard proof panel, computed
from local artifacts, surfaced at the agent's terminal at closeout — so "done" becomes a
**proof readout**, not an assertion.

## 2. Trust boundary (read this first)

`df prove` is run by the same agent that wrote the code **and** authored
`.darkfactory/objectives.yaml`. Its output is therefore **agent-attested,
evidence-backed**:

- **Stronger than free-text "done"** — every binding's status is *derived* from
  diffHash-bound artifacts (route exit codes, critic verdicts), not asserted. The agent
  cannot type "proven"; the join computes it.
- **NOT independent verification.** The agent chose the objectives and the bindings.
  `df prove` proves "the evidence I produced supports the objectives I declared," not
  "an independent party confirmed this PR is correct."

The self-attestation loop closes only with **runner-attested** (hosted-sandbox) evidence
plus the **source-criterion ratchet** (parent spec §4.2/§8) that binds each objective to
a verbatim criterion in the linked cycle doc/issue. Both are out of scope here. This spec
must not be read as delivering independent verification.

## 3. Scope

**In scope (this slice — the capability):**
- `df prove` CLI subcommand + `df_prove` MCP tool (thin wrapper over the same core).
- The `BoundProofRecord` schema + parser in `@momentiq/dark-factory-schemas`.
- A thin join over **existing** loaders — no new evidence subsystem.

**Out of scope — follow-on slice (named in §8):**
- The closeout *obligation*: wiring the skills/doctrine so the agent is *required* to run
  `df prove` and cite it instead of "done".
- The blocking pre-push hook (`df prove --strict` as a gate).

**Out of scope — deferred (parent spec §8):**
- The source-criterion ratchet; runner-attested promotion; the cycle-level objective
  registry.

## 4. Design

### 4.1 Command surface

```
df prove [--commit <ref>] [--cwd <path>] [--json] [--strict]
```

- `--commit` (default `HEAD`), `--cwd` (default process cwd).
- `--json` emits the `BoundProofRecord` as JSON; default is a human readout.
- `--strict` treats every objective as if `enforced: true` (see §4.6).
- `df_prove` (MCP) returns the same record as `structuredContent`, byte-equivalent to
  `--json` (the cycle-5 CLI↔MCP parity rule), so an agent reasons over the record and
  cites it.

### 4.2 Inputs — a thin join over existing loaders

`df prove` reads, for the resolved commit SHA, and **reuses** what already exists:

| Source | Loader (existing) | Yields |
|---|---|---|
| Objectives | `parseObjectivesManifest(.darkfactory/objectives.yaml)` | `Objective[]` + `attestedBy` bindings |
| Route evidence | `readQualityGateEvidence(loaded, sha)` (`evidence/quality-gates.ts`) | `gateResults[routeId].exitCode` + `diffHash` |
| Critic evidence | `loadForCommit(...)` (`lib/show-status-core.ts`) | `criticResults[criticId].verdict` + `diffHash` |
| Published pointers (optional) | the `PublishedEvidence` manifest, when present | `upload_id`s to enrich the record |

No manifest ⇒ "no objectives declared, nothing to prove" (§5). Published pointers are
*enrichment* — the local proof status never depends on them (they exist only after CI's
`df publish`).

### 4.3 Per-binding resolution — a trichotomy

Each `attestedBy` binding resolves to one of **`proven` / `pending` / `failed`**. The
`pending` state is load-bearing: at the local closeout the critic fleet has very likely
**not run on HEAD yet** (it runs in CI / async post-commit), so a critic binding is
`pending` — *awaiting evidence* — not `failed`. Without this distinction `df prove` would
report red on every honest closeout and agents would learn to ignore it.

| Binding | `proven` | `failed` | `pending` |
|---|---|---|---|
| `{kind: route, routeId}` | `gateResults[routeId].exitCode === 0` **and** evidence `diffHash` matches HEAD's diff | `exitCode !== 0` (route ran, blocked) | no evidence for the route, or evidence is SHA-only / `diffHash` mismatch (stale) |
| `{kind: critic, criticId}` | that critic's verdict is `APPROVED` (no open blockers) on HEAD | verdict is `CHANGES_REQUESTED` | no verdict for HEAD yet (fleet hasn't run) — **the crux** |
| `{kind: test, ref}` | a `gateResults[ref]` entry exists with `exitCode === 0`, diffHash-bound | `exitCode !== 0` | no entry for `ref` | 

> v1 resolves a `test` binding through the same gate evidence keyed by `ref` (a
> `test`-kind verification route). A richer standalone test-evidence producer is deferred;
> until one exists, a `test` ref with no matching gate entry is `pending`, never silently
> `proven`.

### 4.4 Objective rollup (worst-of)

An objective's status is the worst of its bindings: **`failed`** if any binding failed,
else **`pending`** if any is pending, else **`proven`**. An objective with an empty
`attestedBy` is `pending` (declared but unbound — surfaced, not silently proven).

### 4.5 The `BoundProofRecord` contract (defined here)

`df prove` **defines** this contract in `@momentiq/dark-factory-schemas`. The Phase 3
worker will later *produce* the same shape server-side (joining runner-attested verdicts),
so the local readout and the server record stay one type — this spec is the contract's
origin, not a consumer of an existing worker type.

```typescript
export type ProofStatus = "proven" | "pending" | "failed";

export interface BoundEvidenceRef {
  kind: "route" | "critic" | "test";   // mirrors EvidenceBinding
  ref: string;                          // routeId | criticId | test ref
  status: ProofStatus;
  // Why this status — a short, human-readable derivation
  // (e.g. "exit 0, diffHash-bound" | "awaiting critic verdict" | "exit 1").
  detail: string;
  // Cerebe pointer, present only once df publish has run for this evidence.
  uploadId?: string;
}

export interface ObjectiveProof {
  id: string;                           // the Objective.id
  text: string;
  enforced: boolean;                    // carried from the manifest
  status: ProofStatus;                  // §4.4 rollup
  bindings: BoundEvidenceRef[];
}

export interface BoundProofRecord {
  schemaVersion: 1;
  commit: string;
  diffHash?: string;                    // the gated diff all evidence binds to
  provenance: "consumer-attested";      // local readout is consumer-attested (§2)
  generatedAt: string;                  // ISO; stamped by the caller, not the parser
  objectives: ObjectiveProof[];
  summary: { proven: number; pending: number; failed: number; total: number };
}
// + parseBoundProofRecord(raw, path?) in the house validation style.
```

### 4.6 Exit codes (the ratchet, made concrete)

`df prove` makes "link now, ratchet later" operational through its exit code:

- **Informational (v1 default).** Objectives ship `enforced: false`. `df prove` **exits 0**
  regardless of `pending`/`failed`, and the readout marks them clearly. The agent is
  *expected* (by doctrine, §8) to read and cite it — but the command does not block.
- **Enforced.** When an objective is `enforced: true` (or `--strict` treats all as such),
  any enforced objective not `proven` makes `df prove` **exit 1**. Flipping the flags — or
  adding `df prove --strict` to a pre-push hook (§8) — turns the readout into a gate with
  zero code change.
- **Exit 2** for a usage/flag error. No manifest ⇒ exit 0 with "nothing to prove".

### 4.7 Readout (human + json)

Human default — per objective: `id`, status glyph, text, each binding's status + `detail`,
and a **next-action hint** for `pending` (e.g. "awaiting critic verdict — run `df review`
or wait for CI"). Footer: `summary` + the bound `diffHash`. `--json` / `df_prove` emit the
`BoundProofRecord` verbatim.

## 5. Edge cases

- **No `.darkfactory/objectives.yaml`** → exit 0, "no objectives declared, nothing to prove."
  Not every PR claims objectives.
- **Stale evidence** (`diffHash` ≠ HEAD's diff) → `pending`, never `proven` (reuses the
  content-binding rule — stale evidence cannot prove the current diff).
- **Objective with an empty `attestedBy`** → `pending` (declared, unbound).
- **Evidence with no objective** → not `df prove`'s concern; it is objective-driven (the
  "unmapped evidence" case belongs to the dashboard/worker join).
- **Transient git error computing HEAD's diffHash** → bindings fall back to `pending`
  rather than false-`proven` (fail-soft toward honesty).

## 6. Testing (TDD, dogfooded)

- **schema:** `parseBoundProofRecord` round-trip + rejects bad `status`/`schemaVersion`;
  summary-count consistency.
- **join core (unit, fixtures):** route `proven`/`failed`/`pending` (incl. stale diffHash
  → pending); critic `proven`/`pending` (no verdict)/`failed`; `test` via gate entry;
  rollup worst-of; empty-`attestedBy` → pending.
- **exit codes:** informational (enforced:false → exit 0 with pending/failed); enforced /
  `--strict` (unproven enforced → exit 1); no-manifest → exit 0; usage → exit 2.
- **CLI↔MCP parity:** `df_prove` `structuredContent` byte-equals `df prove --json`.

## 7. Why this is the keystone

It converts "evidence is stored and surfaceable (passive)" into "the agent must derive and
present proof to declare victory (active)." Even agent-attested, it is checked **at the
moment of the claim** from diffHash-bound artifacts — the difference between *auditable
afterward* and *accountable at closeout*.

## 8. Follow-on (separate slice, named for completeness)

1. **The obligation.** Wire `verification-before-completion` + the `df` skill set +
   `chief-engineer-blitz` handoff doctrine to require `df prove` as the final turn — "done"
   is replaced by its readout.
2. **The gate.** A `df gate-push`-style pre-push hook running `df prove --strict`, so an
   `enforced` objective that is not `proven` blocks the push. This is where the ratchet
   bites.

## 9. References

- Parent design: `dark-factory-platform/.../2026-06-19-verifiable-objectives-evidence-design.md`
- Tracking: momentiq-ai/dark-factory#207 · platform #361
- Reused loaders: `evidence/quality-gates.ts` (`readQualityGateEvidence`),
  `lib/show-status-core.ts` (`loadForCommit`), `@momentiq/dark-factory-schemas`
  (`parseObjectivesManifest`, `PublishedEvidence`).
