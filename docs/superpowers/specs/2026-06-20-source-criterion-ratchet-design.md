---
title: "Source-criterion binding ratchet — agent-asserted → source-verified objectives"
date: 2026-06-20
status: draft
authors: [PJ, Claude Code]
related_repos: [dark-factory, dark-factory-platform]
parent_spec: dark-factory-platform/docs/superpowers/specs/2026-06-19-verifiable-objectives-evidence-design.md
related_issues: [momentiq-ai/dark-factory#207]
cycle: "331.1"
supersedes_scope_of: "verifiable-objectives Phase 2c / spec §8 deferred item"
---

# Source-criterion binding ratchet (verifiable objectives 2c)

## 1. Problem

v1 objectives are **agent-asserted**: `.darkfactory/objectives.yaml` carries the
objective `text` as the coding agent typed it. The validator checks id-format,
trailer-linkage, and route existence — but NOT that the objective corresponds to a
real, verbatim criterion in the linked cycle doc / issue (parent spec §4.2, §8).
This is the gap between *agent-asserted* and *source-verified*: an agent could
declare an objective the source never stated.

2c closes it (where the source is verifiable) by binding each objective to a
**stable source locator + a hash of the verbatim criterion text**, or letting the
author mark it explicitly **`human-reviewed`**. Link-now-ratchet-later applies to
*source-verification itself*: v1 verifies what it can resolve locally and never
welds a flaky network fetch into a blocking gate.

## 2. The one load-bearing decision (please confirm)

**No cross-repo / network fetch on the blocking validation path.** The
cycle-doc-validation gate must stay deterministic + offline-safe. Therefore:

- **Cycle-doc source resolvable in-repo** → verify the hash; a mismatch **fails
  the gate** (real, in-diff error).
- **Source not locally resolvable** (cross-repo cycle doc — e.g. dark-factory's
  own docs live in sage3c during W1 — or an issue body behind the network) →
  record the binding, emit a **non-blocking note**, do NOT fail the gate.
- **`human-reviewed`** → always accepted (the escape).
- The **structure** of `sourceCriterion` (locator format, 64-hex sha256) is
  validated locally + always (a malformed binding fails the gate).

This means: consumers whose cycle docs live in their own repo get real
source-verification; cross-repo/issue verification is a noted follow-on. The
`enforced` coverage ratchet is unchanged + orthogonal.

## 3. Schema (`@momentiq/dark-factory-schemas`)

`Objective` gains an **optional** `sourceCriterion` (backward compatible — an
objective without it stays agent-asserted, exactly as today):

```typescript
export type SourceCriterion =
  | { kind: "text-hash"; locator: string; sha256: string }
  | { kind: "human-reviewed"; by?: string };

export interface Objective {
  // ...existing fields...
  sourceCriterion?: SourceCriterion;
}

// Canonical-hash helper (the SINGLE source of truth shared by the validator's
// verify path and any author-side generate path), exported from schemas:
export function canonicalizeCriterion(text: string): string;  // §4
export const SOURCE_LOCATOR_RE: RegExp;                        // <section-slug>#<criterion-id>
```

`locator` format: `<section-slug>#<criterion-id>` — e.g. `exit_criteria#ec1`
(cycle-doc section slug from the existing parser + the criterion id). `sha256`
is the hex digest of `canonicalizeCriterion(<criterion source text>)`.

## 4. Canonicalization (the crux — must be stable + shared)

`canonicalizeCriterion(text)` normalizes so trivial formatting changes don't
break the hash, while meaning-bearing text does:

1. Strip a leading list marker (`- `, `* `, `1. `) and an optional bold/plain
   criterion label that matches the locator id (`**EC1**`, `EC1:`, `ec1 -`).
2. Strip surrounding markdown emphasis tokens (`**`, `*`, `` ` ``) — not inner.
3. Collapse all internal whitespace runs (incl. newlines) to a single space; trim.
4. NFC-normalize. Case is preserved (meaning-bearing).

The same function is used to (a) generate the author's `sha256` and (b)
recompute it at validation time — they cannot drift.

## 5. Validator (`validate_cycle_doc.py`, in the existing objectives gate)

For each objective with `sourceCriterion` (only when the manifest is in the PR
diff — the Slice A gate still applies):

- `human-reviewed` → accept; record `source: human-reviewed` for `df prove`.
- `text-hash`:
  - Validate `locator` matches `SOURCE_LOCATOR_RE` + `sha256` is 64-hex (local).
  - Resolve the cycle doc **in-repo** (the validator's existing `find_cycle_doc`);
    locate `<section-slug>` then the list item whose id matches `<criterion-id>`
    (label match `EC1`/`ec1`, case-insensitive; else position fallback `ecN` =
    Nth item). Recompute `canonicalizeCriterion` + sha256; **mismatch → error**;
    criterion-not-found → error (the locator is wrong, an in-diff bug).
  - Cycle doc not in-repo / unresolvable → **non-blocking note** (`source
    unverifiable in this environment`), gate passes. (Cross-repo + issue sources:
    follow-on.)

Python recomputes the SAME canonicalization as the TS `canonicalizeCriterion`
(pinned by a shared cross-impl fixture test, extending the Slice A parity model).

## 6. `df prove` surfacing

Each `ObjectiveProof` (the `df prove` / `df_prove` readout) gains a
`sourceVerification: "agent-asserted" | "human-reviewed" | "source-bound"`
field so the closeout readout shows not just *is it proven by evidence* but
*is the objective grounded in its source*:

- `agent-asserted` — no `sourceCriterion` (the v1 default).
- `human-reviewed` — `sourceCriterion.kind === "human-reviewed"`.
- `source-bound` — a `text-hash` binding is declared.

df prove reports the **binding kind**; it does NOT re-verify the hash. The
cycle-doc-validation **gate is the single verifier** (§5) — keeping df prove DRY
and avoiding a second, drift-prone criterion extractor in TS. (A future
`df prove --verify-source` could re-check in-repo using the shared
`canonicalizeCriterion`, but v1 leaves verification to the gate.)

## 7. Authoring

To author a `text-hash` binding, the canonical hash must be computable. v1 ships
the shared `canonicalizeCriterion` + documents the one-liner
(`node -e "...sha256(canonicalizeCriterion(text))"`); a first-class
`df objectives hash <locator>` helper is a **fast-follow** (not v1 — keeps this
slice to the contract + verification).

## 8. Scope

**In:** `sourceCriterion` schema + `canonicalizeCriterion`/`SOURCE_LOCATOR_RE`;
validator structural + in-repo cycle-doc hash verification + `human-reviewed`
escape + non-blocking note for unresolvable sources; `df prove` surfacing; shared
cross-impl canonicalization parity test.

**Out (follow-on):** cross-repo + issue-body source verification (v1 = non-blocking
note); the `df objectives hash` authoring helper; coupling to the `enforced`
coverage ratchet (orthogonal).

## 9. Testing

- schemas: `canonicalizeCriterion` (marker/label/emphasis/whitespace/NFC cases);
  `SOURCE_LOCATOR_RE`; `parseObjective` accepts/round-trips `sourceCriterion`,
  rejects malformed.
- validator (pytest): text-hash match → ok; mismatch → error; criterion-not-found
  → error; source-not-in-repo → non-blocking note; human-reviewed → ok; +
  cross-impl canonicalization parity fixture (TS == Python).
- `df prove`: `sourceVerification` per objective across the four states.

## 10. References

- Parent design §4.2/§7.1/§8: `.../2026-06-19-verifiable-objectives-evidence-design.md`
- df prove design: `docs/superpowers/specs/2026-06-20-df-prove-closeout-proof-design.md`
- Slice A (the diff-gated validator + TS/Python parity model this extends): dark-factory#217
- Tracking: momentiq-ai/dark-factory#207 · platform #361
