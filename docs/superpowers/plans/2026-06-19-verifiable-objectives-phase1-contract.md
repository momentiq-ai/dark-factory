# Verifiable Objectives — Phase 1 (Contract) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define the machine-readable `Objective` contract — the `.darkfactory/objectives.yaml` manifest schema/parser plus a PR-context validator — so later phases can bind verification evidence to a PR's objectives.

**Architecture:** The objective *contract* (types + `parseObjectivesManifest`) lives in `@momentiq/dark-factory-schemas` because the hosted platform worker consumes the identical shape in Phase 3 (cross-repo contract → shared package). The *PR-context cross-checks* (does each objective's `source` match a PR trailer; do `attestedBy` route IDs exist) extend the existing Python `validate_cycle_doc.py`, which already parses PR trailers and runs in the `cycle-doc-validation` gate. Pure contract + validation: no runtime behavior change, no enforcement (the `enforced` flag defaults `false` and is a future ratchet).

**Tech Stack:** TypeScript (hand-rolled runtime validators in the schemas package — NOT zod; vitest tests), Python 3 (`validate_cycle_doc.py` + pytest), YAML (`yaml` pkg in CLI; `pyyaml` in the validator).

## Global Constraints

- **Worktree-first.** Work in `.claude/worktrees/df+objectives-phase1-contract` (branch `df/objectives-phase1-contract`). Never edit the main checkout.
- **Schemas package uses hand-rolled validators**, not zod: mirror the existing `need` / `needEnum` / `optional` / `SchemaError` pattern in `packages/schemas/src/index.ts`. Type-only additions are insufficient — every type gets a `parse*` function.
- **The manifest is the single source of truth for the objective↔evidence binding.** Do NOT add `objectiveId` to `QualityGateEvidence`. Evidence stays keyed by `routeId`/`criticId`; the join happens later in the platform.
- **v1 does NOT check objective coverage.** The validator checks ID format, `source`↔trailer linkage, and `attestedBy` route existence only. `enforced` defaults `false`; no gate fails because an objective is unproven.
- **Separate file, justified:** objectives live in `.darkfactory/objectives.yaml` (not folded into `darkfactory.yaml`) because the contract is consumed cross-repo by the platform worker via the schemas package; consolidating into the CLI's zod-validated `darkfactory.yaml` would split the contract across two validation systems and two repos.
- `npm test` (root: schemas + cli + sage-cli vitest) and `npm run test:python -w @momentiq/dark-factory-cli` must pass before any commit.
- Cite `Cycle: 22` is NOT used (this is design-driven follow-on work); use the spec reference in commit bodies instead.

---

### Task 1: `Objective` contract + parser in `@momentiq/dark-factory-schemas`

**Files:**
- Modify: `packages/schemas/src/index.ts` (add types + parsers alongside `VerificationRoute`, ~line 332, and export the constants near the top-of-file style)
- Test: `packages/schemas/tests/objective.test.ts` (create)

**Interfaces:**
- Consumes: existing helpers in `index.ts` — `need`, `needEnum`, `optional`, `isObject`, `isString`, `isNonEmptyString`, `isBoolean`, `SchemaError`. (Verify exact names against the file; they are used by `parseVerificationRoute`.)
- Produces: `Objective`, `EvidenceBinding`, `ObjectiveSource`, `ObjectivesManifest` types; `OBJECTIVE_ID_RE`; `parseObjectivesManifest(raw: unknown, path?: string): ObjectivesManifest`.

- [ ] **Step 1: Write the failing test**

Create `packages/schemas/tests/objective.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  OBJECTIVE_ID_RE,
  SchemaError,
  parseObjectivesManifest,
  type ObjectivesManifest,
} from "../src/index.js";

const valid: unknown = {
  schemaVersion: 1,
  objectives: [
    {
      id: "cycle21#ec1",
      source: { kind: "cycle", ref: "21" },
      text: "Route table populated for the common change classes.",
      attestedBy: [{ kind: "route", routeId: "targeted-test" }],
      enforced: false,
    },
    {
      id: "issue1234#ac2",
      source: { kind: "issue", ref: "#1234" },
      text: "Dashboard renders the proof panel for a UI route.",
      attestedBy: [
        { kind: "route", routeId: "playwright" },
        { kind: "critic", criticId: "codex" },
      ],
      enforced: false,
    },
  ],
};

describe("parseObjectivesManifest", () => {
  it("accepts a well-formed manifest", () => {
    const m: ObjectivesManifest = parseObjectivesManifest(valid);
    expect(m.schemaVersion).toBe(1);
    expect(m.objectives).toHaveLength(2);
    expect(m.objectives[0].attestedBy[0]).toEqual({ kind: "route", routeId: "targeted-test" });
  });

  it("rejects a malformed objective id", () => {
    const bad = { schemaVersion: 1, objectives: [{ ...((valid as any).objectives[0]), id: "EC1" }] };
    expect(() => parseObjectivesManifest(bad)).toThrow(SchemaError);
  });

  it("rejects an id inconsistent with its source", () => {
    const bad = {
      schemaVersion: 1,
      objectives: [{ ...((valid as any).objectives[0]), id: "issue21#ac1" }],
    };
    expect(() => parseObjectivesManifest(bad)).toThrow(/inconsistent with source/);
  });

  it("rejects an unknown evidence-binding kind", () => {
    const bad = {
      schemaVersion: 1,
      objectives: [{ ...((valid as any).objectives[0]), attestedBy: [{ kind: "vibes" }] }],
    };
    expect(() => parseObjectivesManifest(bad)).toThrow(SchemaError);
  });

  it("exposes the id pattern", () => {
    expect(OBJECTIVE_ID_RE.test("cycle3#ec10")).toBe(true);
    expect(OBJECTIVE_ID_RE.test("issue9#ac1")).toBe(true);
    expect(OBJECTIVE_ID_RE.test("cycle3#xx1")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/schemas && npx vitest run tests/objective.test.ts`
Expected: FAIL — `parseObjectivesManifest`/`OBJECTIVE_ID_RE` are not exported.

- [ ] **Step 3: Add the types + parser to `packages/schemas/src/index.ts`**

Add near the `VerificationRoute` definitions (types) and export `OBJECTIVE_ID_RE` in the constants style used at the top of the file:

```typescript
export type ObjectiveSource = { kind: "cycle" | "issue"; ref: string };

export type EvidenceBinding =
  | { kind: "route"; routeId: string }
  | { kind: "critic"; criticId: string }
  | { kind: "test"; ref: string };

export interface Objective {
  // Stable, PR-independent id. Namespaced by source so the same objective can
  // later be promoted into a cycle-level registry with zero id churn.
  id: string; // "cycle<N>#ec<k>" | "issue<N>#ac<k>"
  source: ObjectiveSource;
  text: string;
  // The binding: which evidence attests this objective. The manifest is the
  // single source of truth — evidence itself carries no objectiveId.
  attestedBy: EvidenceBinding[];
  // Ratchet hook. v1 always false (informational); flipping to true later
  // turns on per-objective coverage enforcement.
  enforced: boolean;
}

export interface ObjectivesManifest {
  schemaVersion: 1;
  objectives: Objective[];
}

export const OBJECTIVE_ID_RE = /^(cycle|issue)\d+#(ec|ac)\d+$/;

function parseObjectiveSource(raw: unknown, path: string): ObjectiveSource {
  const obj = need(isObject, raw, path, "object");
  return {
    kind: needEnum(["cycle", "issue"] as const, obj["kind"], `${path}.kind`),
    ref: need(isNonEmptyString, obj["ref"], `${path}.ref`, "non-empty string"),
  };
}

function parseEvidenceBinding(raw: unknown, path: string): EvidenceBinding {
  const obj = need(isObject, raw, path, "object");
  const kind = needEnum(["route", "critic", "test"] as const, obj["kind"], `${path}.kind`);
  switch (kind) {
    case "route":
      return { kind, routeId: need(isNonEmptyString, obj["routeId"], `${path}.routeId`, "non-empty string") };
    case "critic":
      return { kind, criticId: need(isNonEmptyString, obj["criticId"], `${path}.criticId`, "non-empty string") };
    case "test":
      return { kind, ref: need(isNonEmptyString, obj["ref"], `${path}.ref`, "non-empty string") };
  }
}

function parseObjective(raw: unknown, path: string): Objective {
  const obj = need(isObject, raw, path, "object");
  const id = need(isNonEmptyString, obj["id"], `${path}.id`, "non-empty string");
  if (!OBJECTIVE_ID_RE.test(id)) {
    throw new SchemaError(`${path}.id`, `expected "cycle<N>#ec<k>" or "issue<N>#ac<k>", got ${JSON.stringify(id)}`);
  }
  const source = parseObjectiveSource(obj["source"], `${path}.source`);
  const refNum = source.ref.replace(/^#/, "");
  if (!id.startsWith(`${source.kind}${refNum}#`)) {
    throw new SchemaError(
      `${path}.id`,
      `id ${JSON.stringify(id)} is inconsistent with source { kind: ${source.kind}, ref: ${JSON.stringify(source.ref)} }`,
    );
  }
  const rawBindings = need(
    (v: unknown): v is unknown[] => Array.isArray(v),
    obj["attestedBy"],
    `${path}.attestedBy`,
    "array",
  );
  const attestedBy = rawBindings.map((b, i) => parseEvidenceBinding(b, `${path}.attestedBy[${i}]`));
  return {
    id,
    source,
    text: need(isNonEmptyString, obj["text"], `${path}.text`, "non-empty string"),
    attestedBy,
    enforced: need(isBoolean, obj["enforced"], `${path}.enforced`, "boolean"),
  };
}

export function parseObjectivesManifest(raw: unknown, path = "objectives-manifest"): ObjectivesManifest {
  const obj = need(isObject, raw, path, "object");
  const schemaVersion = need(
    (v: unknown): v is 1 => v === 1,
    obj["schemaVersion"],
    `${path}.schemaVersion`,
    "1",
  );
  const rawObjectives = need(
    (v: unknown): v is unknown[] => Array.isArray(v),
    obj["objectives"],
    `${path}.objectives`,
    "array",
  );
  const objectives = rawObjectives.map((o, i) => parseObjective(o, `${path}.objectives[${i}]`));
  return { schemaVersion, objectives };
}
```

> If a helper name differs in the file (e.g. the array guard or `isObject`), match the existing name used by `parseVerificationRoute` rather than introducing a new one.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/schemas && npx vitest run tests/objective.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full schemas suite (no regressions) + build**

Run: `npm test --workspace=@momentiq/dark-factory-schemas && npm run build --workspace=@momentiq/dark-factory-schemas`
Expected: all pass; build emits with no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/schemas/src/index.ts packages/schemas/tests/objective.test.ts
git commit -m "feat(schemas): Objective contract + parseObjectivesManifest (verifiable-objectives Phase 1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J4HFHViHzTBZ1Zw2jCauEo"
```

---

### Task 2: Objectives validation in `validate_cycle_doc.py`

**Files:**
- Modify: `packages/cli/src/cycle-doc-validator/validate_cycle_doc.py` (add `validate_objectives`, wire into the main `validate()` flow; reuse `parse_trailers`)
- Test: `packages/cli/tests/cycle-doc-validator/test_validate_cycle_doc.py` (add cases)

**Interfaces:**
- Consumes: existing `parse_trailers(text) -> Trailers` (with `.cycle`, `.issue`), and the repo-root resolution the script already uses (`DF_REPO_ROOT` / cwd).
- Produces: appended error strings when `.darkfactory/objectives.yaml` is present and an objective's `source` is unlinked, an `attestedBy` route is unknown, or an id is malformed. Absent manifest → no-op (objectives optional in v1).

- [ ] **Step 1: Write the failing pytest cases**

Add to `packages/cli/tests/cycle-doc-validator/test_validate_cycle_doc.py` (adapt imports/fixtures to the file's existing style — it already imports the module under test):

```python
import textwrap

def _write_manifest(repo_root, body: str):
    d = repo_root / ".darkfactory"
    d.mkdir(parents=True, exist_ok=True)
    (d / "objectives.yaml").write_text(textwrap.dedent(body))

def _write_config(repo_root, route_ids):
    routes = ",".join(
        f'{{"id":"{r}","trigger":["x/**"],"command":null,"evidencePath":null,"category":"c"}}'
        for r in route_ids
    )
    cfg = repo_root / ".agent-review"
    cfg.mkdir(parents=True, exist_ok=True)
    (cfg / "config.json").write_text(
        '{"version":1,"validation":{"verificationRoutes":[' + routes + "]}}"
    )

def test_objectives_ok(tmp_path):
    _write_config(tmp_path, ["targeted-test"])
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: cycle21#ec1
            source: { kind: cycle, ref: "21" }
            text: "Route table populated."
            attestedBy:
              - { kind: route, routeId: targeted-test }
            enforced: false
    """)
    trailers = parse_trailers("Cycle: 21\nCloses #1234\n")
    assert validate_objectives(tmp_path, trailers) == []

def test_objectives_unlinked_source(tmp_path):
    _write_config(tmp_path, ["targeted-test"])
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: cycle99#ec1
            source: { kind: cycle, ref: "99" }
            text: "Orphan."
            attestedBy: [{ kind: route, routeId: targeted-test }]
            enforced: false
    """)
    trailers = parse_trailers("Cycle: 21\n")
    errors = validate_objectives(tmp_path, trailers)
    assert any("not linked" in e for e in errors)

def test_objectives_unknown_route(tmp_path):
    _write_config(tmp_path, ["targeted-test"])
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: cycle21#ec1
            source: { kind: cycle, ref: "21" }
            text: "x"
            attestedBy: [{ kind: route, routeId: nope }]
            enforced: false
    """)
    trailers = parse_trailers("Cycle: 21\n")
    errors = validate_objectives(tmp_path, trailers)
    assert any("verificationRoute" in e for e in errors)

def test_no_manifest_is_noop(tmp_path):
    trailers = parse_trailers("Cycle: 21\n")
    assert validate_objectives(tmp_path, trailers) == []
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/cli && python3 -m pytest tests/cycle-doc-validator/test_validate_cycle_doc.py -q -k objectives`
Expected: FAIL — `validate_objectives` is not defined.

- [ ] **Step 3: Implement `validate_objectives` in `validate_cycle_doc.py`**

Add (the module already `import re` and parses YAML frontmatter, so `import yaml` and `from pathlib import Path` are available or already imported — confirm at top of file):

```python
OBJECTIVE_ID_RE = re.compile(r"^(cycle|issue)\d+#(ec|ac)\d+$")
OBJECTIVES_MANIFEST_PATH = ".darkfactory/objectives.yaml"


def _route_ids(repo_root: Path) -> set[str]:
    cfg = repo_root / ".agent-review" / "config.json"
    if not cfg.exists():
        return set()
    try:
        data = json.loads(cfg.read_text())
    except json.JSONDecodeError:
        return set()
    routes = (data.get("validation") or {}).get("verificationRoutes") or []
    return {r.get("id") for r in routes if isinstance(r, dict) and r.get("id")}


def _declared_refs(trailers: "Trailers") -> set[str]:
    # The PR's declared sources of intent, keyed "<kind>:<ref>" to match an
    # objective's source. Cycle trailer ref is bare ("21"); issue ref keeps "#".
    refs: set[str] = set()
    if trailers.cycle:
        refs.add(f"cycle:{trailers.cycle.strip()}")
    if trailers.issue:
        refs.add(f"issue:{trailers.issue.strip()}")
    return refs


def validate_objectives(repo_root: Path, trailers: "Trailers") -> list[str]:
    """Validate .darkfactory/objectives.yaml against PR context. Empty list = ok.

    v1 checks: id format, source linked by a PR trailer, attestedBy route exists.
    NO coverage check (the `enforced` flag is the future ratchet). Absent manifest
    is a no-op — objectives are optional in v1.
    """
    manifest_path = repo_root / OBJECTIVES_MANIFEST_PATH
    if not manifest_path.exists():
        return []
    try:
        data = yaml.safe_load(manifest_path.read_text()) or {}
    except yaml.YAMLError as exc:
        return [f"{OBJECTIVES_MANIFEST_PATH}: invalid YAML — {exc}"]
    objectives = data.get("objectives")
    if not isinstance(objectives, list):
        return [f"{OBJECTIVES_MANIFEST_PATH}: 'objectives' must be a list"]

    route_ids = _route_ids(repo_root)
    declared = _declared_refs(trailers)
    errors: list[str] = []
    for idx, obj in enumerate(objectives):
        loc = f"{OBJECTIVES_MANIFEST_PATH} objectives[{idx}]"
        if not isinstance(obj, dict):
            errors.append(f"{loc}: expected a mapping")
            continue
        oid = obj.get("id")
        if not isinstance(oid, str) or not OBJECTIVE_ID_RE.match(oid):
            errors.append(f"{loc}.id: expected 'cycle<N>#ec<k>' or 'issue<N>#ac<k>', got {oid!r}")
        source = obj.get("source") or {}
        kind, ref = source.get("kind"), source.get("ref")
        if f"{kind}:{ref}" not in declared:
            errors.append(
                f"{loc}.source: {kind} {ref!r} is not linked by any Cycle:/Closes #N trailer on this PR"
            )
        for j, binding in enumerate(obj.get("attestedBy") or []):
            if isinstance(binding, dict) and binding.get("kind") == "route":
                rid = binding.get("routeId")
                if rid not in route_ids:
                    errors.append(
                        f"{loc}.attestedBy[{j}].routeId: {rid!r} is not a verificationRoute in .agent-review/config.json"
                    )
    return errors
```

If `json` / `yaml` / `Path` are not yet imported at the top of the module, add them.

- [ ] **Step 4: Wire `validate_objectives` into the main `validate()` flow**

Find the existing `validate()` (the function that builds the error/exit-code result from trailers). After trailers are parsed, append objectives errors to the same error collection the function already returns/prints — matching the existing error-reporting style (do not invent a new output format). Example shape (adapt to the real function):

```python
    # ... after: trailers = parse_trailers(body)
    errors.extend(validate_objectives(repo_root, trailers))
```

- [ ] **Step 5: Run the objectives tests, then the full Python suite**

Run: `cd packages/cli && python3 -m pytest tests/cycle-doc-validator/test_validate_cycle_doc.py -q -k objectives`
Expected: PASS (4 cases).

Run: `npm run test:python --workspace=@momentiq/dark-factory-cli`
Expected: full pytest suite passes (no regression in existing trailer/branch-protection tests).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/cycle-doc-validator/validate_cycle_doc.py packages/cli/tests/cycle-doc-validator/test_validate_cycle_doc.py
git commit -m "feat(cli): validate .darkfactory/objectives.yaml in validate-cycle-doc (verifiable-objectives Phase 1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01J4HFHViHzTBZ1Zw2jCauEo"
```

---

### Final: full gate + PR

- [ ] **Step 1: Run the whole test matrix**

Run: `npm test && npm run test:python --workspace=@momentiq/dark-factory-cli`
Expected: schemas + cli + sage-cli vitest pass; pytest passes.

- [ ] **Step 2: Open the PR (auto-merge per repo convention)**

```bash
git push -u origin df/objectives-phase1-contract
gh pr create --title "feat: verifiable-objectives Phase 1 — Objective contract + manifest validator" \
  --body "Phase 1 of the verifiable-objectives design (spec: dark-factory-platform docs/superpowers/specs/2026-06-19-verifiable-objectives-evidence-design.md). Adds the Objective schema + parseObjectivesManifest to @momentiq/dark-factory-schemas and objectives-manifest validation to validate-cycle-doc. Pure contract + validation; no enforcement, no runtime behavior change.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
gh pr merge --auto --squash
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** Phase 1's three scope items map to tasks — `Objective`/`EvidenceBinding` types + ID scheme (Task 1); manifest format = the parser + the example in tests (Task 1); validator extending cycle-doc-validation (Task 2). Cerebe/worker/dashboard/MCP are correctly absent (later phases).
- **Single binding source of truth:** no `objectiveId` added to `QualityGateEvidence` (Global Constraints + Task 1 comment). ✓
- **No coverage enforcement in v1:** validator checks id-format / source-linkage / route-existence only; `enforced` defaults false. ✓
- **Type consistency:** `parseObjectivesManifest` signature, `EvidenceBinding` kinds (`route`/`critic`/`test`), and `OBJECTIVE_ID_RE` are identical across Task 1's code, its tests, and Task 2's Python mirror of the id regex.
- **Placeholders:** none — every step has runnable code/commands. The one judgment call (exact helper names in `index.ts`, exact `validate()` wiring point) is flagged with "match the existing pattern" notes rather than left blank, because the executor must read those two specific spots in the real file.
