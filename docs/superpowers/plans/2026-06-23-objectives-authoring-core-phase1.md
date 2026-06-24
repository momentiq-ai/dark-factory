# Objectives Authoring Core (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the net-new authoring layer for verifiable objectives — the `df objectives derive|hash|check` command, the `inferred` source-criterion provenance rung, and the `/objectives` skill — so a coding agent can *generate* a `.darkfactory/objectives.yaml` from a PR's linked cycle-doc criteria instead of hand-writing it.

**Architecture:** Derive-from-source. `df objectives derive` resolves the branch's linked cycle doc, extracts its `## Exit criteria` items (with `EC<k>` ids), and emits one `Objective` per criterion bound to the verbatim criterion via a `text-hash` (or, when criteria were LLM-drafted but not yet ratified, an `inferred`) `sourceCriterion`. The schema substrate (`sourceCriterion`, `canonicalizeCriterion`, `SOURCE_LOCATOR_RE`, `parseObjectivesManifest`) and the objectives-aware `validate_objectives` already exist — this plan adds the `inferred` rung + the authoring command + the skill on top.

**Tech Stack:** TypeScript (`@momentiq/dark-factory-schemas`, `@momentiq/dark-factory-cli`), vitest; Python (`validate_cycle_doc.py`), pytest; `yaml` npm lib (already a dep).

**Design spec:** `dark-factory-platform/docs/superpowers/specs/2026-06-23-derive-from-source-objectives-design.md`

## Global Constraints

- **Schema is the cross-impl source of truth.** `canonicalizeCriterion` (TS, `packages/schemas/src/index.ts:384`) and `canonicalize_criterion` (Python, `validate_cycle_doc.py:1081`) are byte-for-byte mirrors pinned by a parity fixture — any change stays in lockstep.
- **`inferred` is non-blocking.** The validator treats an `inferred` `sourceCriterion` as a non-blocking NOTE (never a gate-failing error), mirroring the existing `no-doc` note path (`validate_cycle_doc.py:1306`). Ratification = a human flips `inferred` → `text-hash` (same locator+sha256), an auditable diff.
- **CLI command contract (mirror `cmdProve`/`cmdVerify`):** pure `parseObjectivesArgs(rest)` → options-or-`{error}`; `async cmdObjectives(rest, io, deps?): Promise<number>`; `--json` + human output; exit `0` success / `1` semantic failure / `2` usage error.
- **Derive never re-infers at gate time.** It writes a committed manifest; the worker reads the committed file (no runtime re-inference). `derive` is idempotent and must NOT clobber hand-edited `attestedBy` bindings on re-run.
- **Commit identity:** author = your `git config user.*`; committer email `claude-code+<handle>@momentiq.ai`; trailer `Co-Authored-By: Claude <model> <noreply@anthropic.com>`.

---

### Task 1: `inferred` rung in the schema (`@momentiq/dark-factory-schemas`)

**Files:**
- Modify: `packages/schemas/src/index.ts` (the `SourceCriterion` union `:371`; `parseSourceCriterion` `:2434`; the `SourceVerification` type + its doc near `:502`)
- Test: `packages/schemas/tests/source-criterion.test.ts`

**Interfaces:**
- Produces: `SourceCriterion` now includes `{ kind: "inferred"; locator: string; sha256: string }`; `parseSourceCriterion` accepts it; `SourceVerification` includes `"inferred"`.

- [ ] **Step 1: Write the failing tests** in `source-criterion.test.ts` (mirror the existing `text-hash` cases):

```typescript
it("parses an inferred sourceCriterion (locator + sha256, same shape as text-hash)", () => {
  const o = parseObjectivesManifest({
    schemaVersion: 1,
    objectives: [{
      id: "cycle23#ec1", source: { kind: "cycle", ref: "23" }, text: "x",
      attestedBy: [{ kind: "critic", criticId: "codex" }], enforced: false,
      sourceCriterion: { kind: "inferred", locator: "exit_criteria#ec1", sha256: "a".repeat(64) },
    }],
  });
  expect(o.objectives[0].sourceCriterion).toEqual({
    kind: "inferred", locator: "exit_criteria#ec1", sha256: "a".repeat(64),
  });
});

it("rejects an inferred binding with a malformed locator", () => {
  expect(() => parseObjectivesManifest({
    schemaVersion: 1,
    objectives: [{ id: "cycle23#ec1", source: { kind: "cycle", ref: "23" }, text: "x",
      attestedBy: [{ kind: "critic", criticId: "codex" }], enforced: false,
      sourceCriterion: { kind: "inferred", locator: "NOT A LOCATOR", sha256: "a".repeat(64) } }],
  })).toThrow();
});
```

- [ ] **Step 2: Run, verify failure** — `npm test --workspace=@momentiq/dark-factory-schemas -- source-criterion` → FAIL (`inferred` rejected by parser).
- [ ] **Step 3: Implement** — extend the union at `:371`:

```typescript
export type SourceCriterion =
  | { kind: "text-hash"; locator: string; sha256: string }
  | { kind: "human-reviewed"; by?: string }
  | { kind: "inferred"; locator: string; sha256: string }; // drafted-to-source, NOT yet ratified
```

In `parseSourceCriterion` (`:2434`), add an `inferred` branch that reuses the exact `text-hash` validation (locator vs `SOURCE_LOCATOR_RE`, sha256 vs 64-hex). Add `"inferred"` to the `SourceVerification` union and its doc comment.

- [ ] **Step 4: Run, verify pass** — same command → PASS. Then full `npm test --workspace=@momentiq/dark-factory-schemas` → all green.
- [ ] **Step 5: Commit** — `feat(schemas): add inferred source-criterion rung — objectives Phase 1`.

---

### Task 2: `df prove` surfaces `inferred`

**Files:**
- Modify: `packages/cli/src/evidence/prove.ts:145-150` (the `sourceVerification` derivation)
- Test: `packages/cli/tests/evidence/prove.test.ts`

**Interfaces:**
- Consumes: `SourceCriterion` with `inferred` (Task 1).
- Produces: `ObjectiveProof.sourceVerification === "inferred"` when `sourceCriterion.kind === "inferred"`.

- [ ] **Step 1: Failing test** — add a case asserting an objective with `sourceCriterion.kind:"inferred"` yields `sourceVerification:"inferred"`.
- [ ] **Step 2: Verify failure** — `npm test --workspace=@momentiq/dark-factory-cli -- evidence/prove` → FAIL.
- [ ] **Step 3: Implement** — extend the ternary at `:145`:

```typescript
const sourceVerification: SourceVerification =
  o.sourceCriterion === undefined ? "agent-asserted"
  : o.sourceCriterion.kind === "human-reviewed" ? "human-reviewed"
  : o.sourceCriterion.kind === "inferred" ? "inferred"
  : "source-bound";
```

- [ ] **Step 4: Verify pass.** **Step 5: Commit** — `feat(cli): df prove surfaces inferred source-verification — objectives Phase 1`.

---

### Task 3: Validator treats `inferred` as a non-blocking note (Python)

**Files:**
- Modify: `packages/cli/src/cycle-doc-validator/validate_cycle_doc.py` (`validate_objectives` sourceCriterion block `:1288-1327`)
- Test: `packages/cli/tests/cycle-doc-validator/test_validate_cycle_doc.py`

**Interfaces:**
- Consumes: a manifest objective whose `sourceCriterion.kind == "inferred"`.
- Produces: a non-blocking `[objectives] note: ... inferred (awaiting ratification)` printed to stdout; the objective contributes **no** entry to the returned `errors` list.

- [ ] **Step 1: Failing test** — a manifest with one `inferred` objective (valid locator+sha256, in the changed_files) returns `[]` errors AND prints a note. Assert `errors == []` and the captured stdout contains `inferred`.
- [ ] **Step 2: Verify failure** — `pytest packages/cli/tests/cycle-doc-validator/test_validate_cycle_doc.py -k inferred -v` → FAIL (current code only knows `text-hash`/`human-reviewed`).
- [ ] **Step 3: Implement** — in the `sourceCriterion` block (`:1288`), branch on `kind == "inferred"`: validate structure (locator `SOURCE_LOCATOR_RE`, sha256 64-hex) as a hard error if malformed; otherwise emit the non-blocking note via the same `print()` path used for `no-doc` (`:1306`). Do NOT recompute/verify the hash (inferred is by definition not-yet-ratified).
- [ ] **Step 4: Verify pass.** **Step 5: Commit** — `feat(validator): inferred source-criterion → non-blocking note — objectives Phase 1`.

---

### Task 4: `df objectives hash` (canonical-hash helper)

**Files:**
- Create: `packages/cli/src/commands/objectives.ts` (command scaffold + `hash` subcommand)
- Modify: `packages/cli/src/cli.ts` (register `objectives` dispatch, mirroring `PROVE_SUBCOMMANDS`)
- Test: `packages/cli/tests/objectives.test.ts` (create)

**Interfaces:**
- Produces: `cmdObjectives(rest, io, deps?)`; `parseObjectivesArgs(rest)`; `df objectives hash --text "<criterion>"` prints `sha256(canonicalizeCriterion(text))`; `df objectives hash --locator <loc> --cycle <id>` resolves the in-repo criterion text then hashes it.

- [ ] **Step 1: Failing test** — `cmdObjectives(["hash","--text","- **EC1**: Foo bar"], io)` writes the hex digest of `canonicalizeCriterion("- **EC1**: Foo bar")` to stdout and returns `0`. (Import `canonicalizeCriterion` from schemas to compute the expected value in the test.)
- [ ] **Step 2: Verify failure** — `npm test --workspace=@momentiq/dark-factory-cli -- objectives` → FAIL (module missing).
- [ ] **Step 3: Implement** — scaffold `objectives.ts` mirroring `prove.ts` (Io interface, `parseObjectivesArgs` discriminated on `subcommand`, help text, exit codes). Implement `hash`:

```typescript
import { createHash } from "node:crypto";
import { canonicalizeCriterion } from "@momentiq/dark-factory-schemas";
// ...
const digest = createHash("sha256").update(canonicalizeCriterion(text), "utf8").digest("hex");
io.stdout(digest + "\n");
return 0;
```

Register in `cli.ts`: `const OBJECTIVES_SUBCOMMANDS = new Set(["objectives"]);` + dispatch to `cmdObjectives`.

- [ ] **Step 4: Verify pass** (+ `cli-subcommands.test.ts` still green — the new top-level command appears in help). **Step 5: Commit** — `feat(cli): df objectives hash — objectives Phase 1`.

---

### Task 5: `df objectives derive` (the core engine)

**Files:**
- Modify: `packages/cli/src/commands/objectives.ts` (add `derive` + a `extractExitCriteria` helper)
- Test: `packages/cli/tests/objectives.test.ts`

**Interfaces:**
- Consumes: `readCycleDoc(repoRoot, cycleId)` (`packages/cli/src/mcp/cycle-doc/parser.ts`) → `ParsedCycleDoc { sections: Record<slug, body> }`; `canonicalizeCriterion`, `SOURCE_LOCATOR_RE`, `parseObjectivesManifest` (schemas); `yaml.stringify`.
- Produces: `df objectives derive --cycle <N> [--apply]` writes/prints a `.darkfactory/objectives.yaml` with one `Objective` per `## Exit criteria` item — `id: cycle<N>#ec<k>`, `source:{kind:cycle,ref:"<N>"}`, `text:<criterion>`, `attestedBy:[]` (placeholder for the agent), `enforced:false`, `sourceCriterion:{kind:"text-hash",locator:"exit_criteria#ec<k>",sha256:<hash>}`.
- Produces helper: `extractExitCriteria(sectionBody: string): Array<{ id: string; text: string }>` — parses `- ` / `* ` / `N. ` list items, reads a leading `EC<k>`/`**EC<k>**` label (case-insensitive) else positional `ec<index>`.

- [ ] **Step 1: Failing test for `extractExitCriteria`** — body `"- \`EC1\` Route table populated.\n- \`EC2\` Panel renders."` → `[{id:"ec1",text:"Route table populated."},{id:"ec2",text:"Panel renders."}]`. (Pin the label + positional-fallback behavior here.)
- [ ] **Step 2: Failing test for `derive`** — with a fixture repo whose `docs/roadmap/cycles/cycle23-*.md` has a 2-item Exit criteria section, `cmdObjectives(["derive","--cycle","23"], io)` prints YAML that round-trips through `parseObjectivesManifest` to 2 objectives with `sourceCriterion.kind:"text-hash"` and locators `exit_criteria#ec1/2` and the correct sha256 (compare to `canonicalizeCriterion`).
- [ ] **Step 3: Verify failure** — `npm test --workspace=@momentiq/dark-factory-cli -- objectives` → FAIL.
- [ ] **Step 4: Implement** `extractExitCriteria` + the `derive` handler (resolve cycle doc → `sections["exit_criteria"]` → extract → map to `Objective[]` → `yaml.stringify({schemaVersion:1, objectives})`; `--apply` writes `.darkfactory/objectives.yaml`, default prints). **Idempotence:** if the file exists, preserve each objective's existing `attestedBy` by id when re-emitting (merge, don't clobber).
- [ ] **Step 5: Verify pass.** **Step 6: Commit** — `feat(cli): df objectives derive — generate manifest from cycle-doc exit criteria — objectives Phase 1`.

---

### Task 6: `df objectives check` (local gate mirror)

**Files:**
- Modify: `packages/cli/src/commands/objectives.ts` (add `check`)
- Test: `packages/cli/tests/objectives.test.ts`

**Interfaces:**
- Produces: `df objectives check` parses `.darkfactory/objectives.yaml` via `parseObjectivesManifest` (structure) and, for each `text-hash` binding, recomputes `canonicalizeCriterion`+sha256 against the in-repo cycle doc (reusing `readCycleDoc` + `extractExitCriteria`); reports `ok` / per-objective failures; `inferred` → informational note, never a failure. Exit `0` ok / `1` mismatch / `2` usage.

- [ ] **Step 1: Failing tests** — (a) a manifest matching its cycle doc → exit `0`; (b) a tampered `text-hash` sha256 → exit `1` naming the objective; (c) an `inferred` objective → exit `0` + a note.
- [ ] **Step 2: Verify failure.** **Step 3: Implement** `check` (DRY: reuse `extractExitCriteria` from Task 5; the hash recompute mirrors the Python validator's `_resolve_criterion` semantics). **Step 4: Verify pass.** **Step 5: Commit** — `feat(cli): df objectives check — local source-binding verification — objectives Phase 1`.

---

### Task 7: `/objectives` skill

**Files:**
- Create: `packages/cli/skills/objectives/skill.json`, `packages/cli/skills/objectives/SKILL.md.tmpl`
- Test: `packages/cli/tests/objectives.test.ts` (or the existing skills test) — assert `df skills list` includes `objectives` and the template renders.

**Interfaces:**
- Consumes: the skills mechanism (`skill-schema.json`; mirror `skills/verify/`).
- Produces: a `/objectives` skill whose `SKILL.md` instructs an agent, at plan time, to: resolve the linked cycle/issue, run `df objectives derive --cycle <N>`, bind each objective's `attestedBy` to a real route/test (critic only as a labeled on-ramp), surface the objectives in the plan for agreement, and (when criteria were inferred) ratify `inferred`→`text-hash`.

- [ ] **Step 1: Failing test** — assert `objectives` appears in the skills bundle list + `SKILL.md.tmpl` renders with its vars.
- [ ] **Step 2: Verify failure.** **Step 3: Implement** `skill.json` (name `objectives`, summary, the `SKILL.md.tmpl`→`SKILL.md` file mapping, vars mirroring `verify`) + author `SKILL.md.tmpl` (the planning-flow authoring guide; weak-vs-real-proof caveat; ratify flow). **Step 4: Verify pass.** **Step 5: Commit** — `feat(cli): /objectives skill — plan-time authoring guide — objectives Phase 1`.

---

### Final: full gate + PR

- [ ] Run `npm run type-check && npm test && npm run build` at the repo root → all green.
- [ ] Run the python validator tests: `pytest packages/cli/tests/cycle-doc-validator/ -v` → green.
- [ ] **Dogfood:** in this repo run `df objectives derive --cycle <this-cycle>` and commit the generated `.darkfactory/objectives.yaml` (this PR proves its own objectives — the recursive dogfood).
- [ ] Open the PR referencing the spec + `momentiq-ai/dark-factory#207`.

## Self-Review

- **Spec coverage:** Tasks 1–3 (inferred rung across schema/prove/validator), 4–6 (`df objectives hash|derive|check`), 7 (skill) cover Phase 1 of §9. Phases 2–6 (guidance/distribution/surface/enforcement) are out of scope here.
- **Type consistency:** `cmdObjectives`/`parseObjectivesArgs`/`extractExitCriteria`/`ObjectivesIo` names are consistent across Tasks 4–6; `SourceCriterion`/`SourceVerification` extensions consistent across Tasks 1–3.
- **No placeholders:** every task has concrete tests + code anchors + exact paths/commands.
