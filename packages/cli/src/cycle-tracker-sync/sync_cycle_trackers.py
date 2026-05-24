"""Continuous sync of GitHub tracker issues for cycle docs.

Renamed in Cycle 326 (was `backfill_cycle_issues.py`). The cycle 323
one-shot backfill became continuous: instead of a hardcoded list of
cycle IDs, this script discovers cycle docs by glob and reconciles the
tracker-issue state on every run.

Pipeline (per spec § Architecture):

  1. Glob `docs/roadmap/cycles/cycle*.md` (exclude `archive/`).
  2. Parse cycle ID from each FILENAME (not frontmatter — filename is
     authoritative; guards against YAML float parsing of `cycle: 205.10`
     → `205.1` data-loss).
  3. Group by cycle ID. When multiple docs share an ID, pick the
     canonical one in priority order:
       (1) filter out `status: superseded` OR docs with a non-null
           `supersededBy:` / `superseded_by:` frontmatter (normalize
           both spellings — both appear in the corpus)
       (2) prefer `status: in-progress` over draft/completed/other
       (3) longest filename (most descriptive slug)
       (4) alphabetical tiebreaker
     Non-canonical docs become `[collision]` log lines (NOT independent
     trackers).
  4. For each canonical cycle doc, resolve parent cycle:
       (a) explicit `parent_cycle:` frontmatter wins
       (b) otherwise, infer parent = cycle ID minus the last dot segment
           (e.g. `322.7.1` → `322.7`, `318.4` → `318`, `100` → null)
     Label = `type:sub-cycle` if parent resolved, else `type:cycle`.
  5. Lookup existing same-title tracker (any label, any state). Three
     outcomes:
       - Found, correctly labeled  → reuse, re-add to project (idempotent)
       - Found, wrong label        → ADOPT: add the missing label, wire
                                     parent if applicable, add to project,
                                     set fields. Issue body + title are
                                     NOT changed.
       - Not found                 → CREATE: new issue with the correct
                                     label + body from doc, add to
                                     project, wire parent.
  6. Sub-issue parent link via GraphQL `addSubIssue` — ONLY when parent
     resolved AND parent's cycle doc exists on disk. Orphan-parent
     fail-soft: when parent has no doc (4 cases in corpus today: 177,
     203, 307, 309), skip the mutation and emit `[warn] parent <id> has
     no cycle doc; sub-issue link skipped for <child-id>`.
  7. Add to project #2 on momentiq-ai (idempotent).
  8. Set custom fields from frontmatter: `Wave`, `Priority`, `Cycle Doc`,
     `Item Type` (Cycle / Sub-Cycle). `Cycle Doc` field value is derived
     from the doc PATH (the doc IS the cycle_doc artifact), not from a
     frontmatter key.

Modes:
  (default)        Full sync — create or adopt trackers, wire parents,
                   populate fields. Idempotent.
  --issues-only    Skip the project-field population pass (Phase C);
                   useful when project fields are intentionally not yet
                   defined or the operator wants a fast tracker-only run.
  --dry-run        Hermetic: print intended ops with NO gh calls.

Spec: docs/superpowers/specs/2026-05-17-gh-project-continuous-sync.md
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Optional

import yaml

import os

REPO = "momentiq-ai/sage3c"
PROJECT_OWNER = "momentiq-ai"
PROJECT_NUMBER = 2

CYCLES_DIR_DEFAULT = Path("docs/roadmap/cycles")

# Token strategy (per spec § Commit 3, Strategy A):
#   - GH_TOKEN (or GITHUB_TOKEN) — used for repo issue mutations
#     (gh issue create/edit/list, addSubIssue on issue node IDs).
#     The workflow's `permissions: issues: write` block grants this.
#   - PROJECT_TOKEN — classic PAT with `project` scope. Used ONLY for
#     project-v2 mutations (addProjectV2ItemById, gh project item-add /
#     item-edit, updateProjectV2ItemFieldValue) which the workflow-level
#     GITHUB_TOKEN cannot do for org-level Projects v2.
# Resolved at module import time so subprocess.run can pass them down.


def _project_env() -> dict:
    """Return an env dict that overrides GH_TOKEN with PROJECT_TOKEN for
    org-level Projects v2 calls. Falls back to the existing GH_TOKEN if
    PROJECT_TOKEN isn't set (e.g., local invocation where the PAT is
    already exported as GH_TOKEN). Always returns a fresh dict — callers
    use `subprocess.run(..., env=...)`."""
    env = os.environ.copy()
    project_token = os.environ.get("PROJECT_TOKEN")
    if project_token:
        env["GH_TOKEN"] = project_token
        # Also unset GITHUB_TOKEN if present so gh doesn't prefer it.
        env.pop("GITHUB_TOKEN", None)
    return env

# Filename → cycle ID parser.
# Accepts:
#   cycle318.4-foo.md      → "318.4"
#   cycle318.4.md          → "318.4"
#   cycle100-bar.md        → "100"
#   cycle100.md            → "100"
#   cycle10_meta_learn.md  → "10"       (legacy underscore separator)
#   cycle308-2-foo.md      → "308.2"    (legacy dash-replaces-dot variant)
#   cycle308-3-foo.md      → "308.3"
# Rejects:
#   cycle.md, cycleN.NN.md where NN parses as YAML float (filename only;
#   frontmatter is never the cycle-ID source — see § Decisions).
#
# Order matters: try dot-form first (and ONLY dot-form for any filename
# already containing `.`), then dash-replaces-dot for filenames using the
# legacy `cycleN-N-...` form, then single-segment cycle docs.
#
# The dash-replaces-dot pattern captures *any* digit count in both
# segments because the legacy corpus uses single-digit sub-cycles only
# (308-2, 308-3) but we don't rely on that — the dot-form regex always
# wins first, so a filename like `cycle318.4-foo.md` is canonicalized
# to `318.4` via the dot-form pattern before the dash-pattern is
# considered. Filenames like `cycle318-4-foo.md` (no dot anywhere) are
# only produced by the legacy convention, where they too should map
# to `318.4`. The two readings are intentionally congruent.
CYCLE_ID_FILENAME_RES = (
    re.compile(r"^cycle(\d+(?:\.\d+)+)(?:[-_].+)?\.md$"),    # 318.4-foo / 318.4.md
    re.compile(r"^cycle(\d+)-(\d+)(?:-.+)?\.md$"),           # 308-2-foo → 308.2
    re.compile(r"^cycle(\d+)(?:[-_].+)?\.md$"),              # 100-foo / 10_meta / 100.md
)

# `supersededBy` / `superseded_by` are BOTH valid spellings in the corpus.
SUPERSEDED_BY_KEYS = ("supersededBy", "superseded_by")


# ─────────────────────────────────────────────────────────────────────────
# Pure data-layer functions (no gh CLI calls)
# ─────────────────────────────────────────────────────────────────────────


def parse_cycle_id_from_filename(filename: str) -> Optional[str]:
    """Extract a cycle ID from a doc filename.

    Returns the canonical dotted form (`318.4`, `100`) or None if the
    name doesn't look like a cycle doc.
    """
    for pat in CYCLE_ID_FILENAME_RES:
        m = pat.match(filename)
        if m:
            if pat.groups == 2:  # dash-replaces-dot (308-2-foo)
                return f"{m.group(1)}.{m.group(2)}"
            if len(m.groups()) == 2:  # dash-replaces-dot
                return f"{m.group(1)}.{m.group(2)}"
            return m.group(1)
    return None


def discover_cycle_docs(
    cycles_dir: Optional[Path] = None, root: Optional[Path] = None
) -> dict[str, list[Path]]:
    """Find every cycle doc under cycles_dir and group by cycle ID.

    Returns: { cycle_id: [path1, path2, ...] }. Multiple paths per ID
    indicate a duplicate-cycle-ID collision; the caller picks the
    canonical one via `select_canonical_doc`.

    Excludes `archive/` subdirectories.
    """
    root = root or Path.cwd()
    cycles_dir = cycles_dir or (root / CYCLES_DIR_DEFAULT)
    if not cycles_dir.is_absolute():
        cycles_dir = (root / cycles_dir).resolve()
    grouped: dict[str, list[Path]] = {}
    for path in sorted(cycles_dir.glob("cycle*.md")):
        # Defensive: skip anything under an archive/ subtree even though
        # glob() with no `**` shouldn't recurse.
        if "archive" in path.parts:
            continue
        cycle_id = parse_cycle_id_from_filename(path.name)
        if cycle_id is None:
            continue
        grouped.setdefault(cycle_id, []).append(path)
    return grouped


def parse_frontmatter(doc_path: Path) -> dict:
    """Extract YAML frontmatter from a cycle doc.

    Returns {} if the file has no frontmatter block. yaml.safe_load
    handles YAML floats safely IF the frontmatter doesn't use them
    in cycle-id-shaped fields — we don't rely on frontmatter for cycle
    IDs at all (see parse_cycle_id_from_filename) which sidesteps the
    `cycle: 205.10` → 205.1 trap.
    """
    text = doc_path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return {}
    end = text.find("---", 3)
    if end < 0:
        return {}
    try:
        return yaml.safe_load(text[3:end]) or {}
    except yaml.YAMLError:
        return {}


def is_superseded(frontmatter: dict) -> bool:
    """Return True if the doc is marked superseded by frontmatter.

    Accepts both spellings of the supersession key. Treats:
      - status: superseded  → True
      - supersededBy: <anything truthy and not null/empty>  → True
      - superseded_by: <anything truthy and not null/empty>  → True
    """
    status = (frontmatter.get("status") or "").strip().strip("\"'").lower()
    if status == "superseded":
        return True
    for key in SUPERSEDED_BY_KEYS:
        val = frontmatter.get(key)
        if val is None:
            continue
        # YAML can yield empty string or "null" — treat as not set.
        if isinstance(val, str):
            normalized = val.strip().strip("\"'").lower()
            if normalized in ("", "null", "none"):
                continue
            return True
        # Any non-string truthy value (int, dict, list) counts as "set".
        if val:
            return True
    return False


def select_canonical_doc(cycle_id: str, docs: list[Path]) -> tuple[Path, list[Path]]:
    """Pick the canonical doc for a cycle ID, returning (canonical, collisions).

    Priority order (per spec § Decisions):
      (1) filter out superseded docs (status: superseded OR non-null
          supersededBy:/superseded_by:)
      (2) prefer status: in-progress over draft/completed/other
      (3) longest filename
      (4) alphabetical tiebreaker

    `collisions` is the list of all OTHER (non-canonical) docs for this
    cycle ID; the caller logs them as `[collision]` entries. If the
    input list has length 1, collisions = [].
    """
    if len(docs) == 1:
        return docs[0], []

    annotated = []
    for p in docs:
        fm = parse_frontmatter(p)
        annotated.append({
            "path": p,
            "frontmatter": fm,
            "superseded": is_superseded(fm),
            "status": (fm.get("status") or "").strip().strip("\"'").lower(),
        })

    # Step 1: filter out superseded.
    survivors = [a for a in annotated if not a["superseded"]]
    if not survivors:
        # All are superseded — fall back to the full set so the cycle
        # still gets a tracker. The first one wins via the remaining
        # tiebreakers; the warning lives in the caller's log.
        survivors = annotated

    # Step 2: prefer in-progress over draft/completed/other.
    in_progress = [a for a in survivors if a["status"] == "in-progress"]
    if in_progress:
        survivors = in_progress

    # Step 3 & 4: longest filename, alphabetical tiebreaker.
    # max() with a tuple key — longer filename first, then alphabetical
    # by name (sorted-ascending → max takes the last alphabetically).
    # To make alphabetical PICK the first alphabetically (deterministic
    # in test fixtures), we negate via tuple of (length, -ord(name)).
    # Simpler: sort by (-len(name), name) and take the first.
    survivors.sort(key=lambda a: (-len(a["path"].name), a["path"].name))
    canonical = survivors[0]["path"]
    collisions = [p for p in docs if p != canonical]
    return canonical, collisions


def resolve_parent(cycle_id: str, frontmatter: dict) -> Optional[str]:
    """Resolve the parent cycle ID for a doc.

    Priority:
      1. Explicit `parent_cycle:` frontmatter (non-null) wins.
      2. Otherwise, infer parent = cycle ID minus the last dot segment
         (e.g. `322.7.1` → `322.7`, `318.4` → `318`, `100` → None).

    Returns None for top-level cycles.
    """
    raw = frontmatter.get("parent_cycle")
    if raw is not None:
        # Could be int, float (BAD if YAML float), or str. Normalize to str.
        if isinstance(raw, (int, float)):
            return str(raw)
        if isinstance(raw, str):
            normalized = raw.strip().strip("\"'").lower()
            if normalized not in ("", "null", "none"):
                return raw.strip().strip("\"'")
        # Falls through to inference if frontmatter is empty/null/none.

    # Inference: drop the last dot segment.
    if "." in cycle_id:
        return cycle_id.rsplit(".", 1)[0]
    return None


def repo_relative_path(path: Path, root: Optional[Path] = None) -> Path:
    """Return a path suitable for GitHub blob URLs and project fields."""
    root = (root or Path.cwd()).resolve()
    resolved = path.resolve()
    try:
        return resolved.relative_to(root)
    except ValueError:
        raise ValueError(f"{resolved} is not under repository root {root}") from None


def build_issue_body(cycle_id: str, doc_path: Path, frontmatter: dict) -> str:
    """Issue body: link to doc + key frontmatter fields. Absolute URL because
    issue bodies do not resolve repo-relative links the way in-repo markdown does."""
    rel_doc_path = repo_relative_path(doc_path).as_posix()
    doc_url = f"https://github.com/{REPO}/blob/main/{rel_doc_path}"
    return (
        f"Tracking issue for [{doc_path.name}]({doc_url}).\n\n"
        f"**Status**: {frontmatter.get('status', 'unknown')}\n"
        f"**Wave**: {frontmatter.get('wave', 'n/a')}\n"
        f"**Priority**: {frontmatter.get('priority', 'n/a')}\n\n"
        f"This issue is the project-item tracker for Cycle {cycle_id}.\n"
        f"The cycle doc is the source of truth for design; this issue is the trackable item.\n"
    )


def plan_operations(
    grouped_docs: dict[str, list[Path]], parent_doc_exists_lookup: dict[str, bool]
) -> tuple[list[dict], list[dict]]:
    """Build the list of operations from grouped docs.

    Returns (ops, collisions):
      ops:        one entry per canonical cycle ID, with title/body/label/
                  parent_cycle/parent_doc_exists/doc_path fields.
      collisions: log entries for non-canonical duplicate docs.

    `parent_doc_exists_lookup`: a {cycle_id → bool} map indicating whether
    a cycle doc exists for that ID. Built from `grouped_docs.keys()`.
    """
    ops: list[dict] = []
    collisions: list[dict] = []
    for cycle_id in sorted(grouped_docs.keys(), key=_cycle_id_sort_key):
        docs = grouped_docs[cycle_id]
        canonical, others = select_canonical_doc(cycle_id, docs)
        if others:
            collisions.append({
                "cycle_id": cycle_id,
                "canonical": canonical,
                "others": others,
            })
        frontmatter = parse_frontmatter(canonical)
        raw_title = frontmatter.get("title", f"Cycle {cycle_id}")
        if raw_title.startswith("Cycle"):
            title = raw_title
        else:
            title = f"Cycle {cycle_id}: {raw_title}"
        parent_id = resolve_parent(cycle_id, frontmatter)
        parent_doc_exists = bool(parent_id) and parent_doc_exists_lookup.get(parent_id, False)
        label = "type:sub-cycle" if parent_id else "type:cycle"
        ops.append({
            "cycle_id": cycle_id,
            "title": title,
            "body": build_issue_body(cycle_id, canonical, frontmatter),
            "label": label,
            "parent_cycle": parent_id,
            "parent_doc_exists": parent_doc_exists,
            "doc_path": canonical,
            "frontmatter": frontmatter,
        })
    return ops, collisions


def _cycle_id_sort_key(cycle_id: str) -> tuple:
    """Sort cycle IDs as semver-ish tuples (3 < 3.1 < 3.10 < 4)."""
    return tuple(int(seg) if seg.isdigit() else seg for seg in cycle_id.split("."))


# ─────────────────────────────────────────────────────────────────────────
# gh CLI shell-out helpers
# ─────────────────────────────────────────────────────────────────────────


def gh_create_issue(title: str, body: str, label: str) -> int:
    """Create a repo issue; return its number parsed from the URL gh prints."""
    result = subprocess.run(
        ["gh", "issue", "create",
         "--repo", REPO,
         "--title", title,
         "--body", body,
         "--label", label],
        capture_output=True, text=True, check=True,
    )
    url = result.stdout.strip()
    return int(url.rsplit("/", 1)[-1])


# Bulk-fetch page size for `gh issue list --search` (issue #1998).
# Set high enough that a single call covers the entire corpus today
# (~300 trackers) with headroom. If the corpus ever grows past this
# limit, `gh_fetch_all_cycle_trackers()` raises rather than silently
# returning a truncated set that would cause Phase A to mass-duplicate.
_BULK_FETCH_LIMIT = 5000


def gh_fetch_all_cycle_trackers() -> list[dict]:
    """Bulk-fetch every existing cycle-tracker issue in ONE search call.

    Returns a list of `{"number", "title", "labels": [{"name": …}, …]}` dicts.

    Why bulk-fetch? (issue #1998)
      Per-cycle `gh issue list --search` calls (~300+ per run) hammer
      GitHub's search API. The search endpoint has a stricter quota
      (~30 requests/min) than the core API and triggers secondary
      abuse-rate-limiting once exceeded. Secondary limits surface as
      `HTTP 401: Bad credentials` (not 403 / 429) on the graphql
      endpoint — which historically led to a misdiagnosis as token
      expiration. The same token both succeeded and 401'd within a
      single run, which is the secondary-rate-limit signature.

      Replacing N per-cycle searches with ONE bulk fetch + in-memory
      lookup eliminates the rate-limit class of failure entirely.

    Bulk-fetch safety (Codex P1 review on PR for #1998):
      `gh issue list --limit N` is a MAX, not pagination — it pages
      internally up to N then stops. If the corpus exceeds N silently,
      the index drops older trackers, lookups return None, and Phase A
      takes the CREATE path → mass-duplicates. Defence: fetch with
      headroom (5000 vs current ~300 corpus) AND raise if we hit the
      limit exactly. The caller's `execute()` already treats a fetch
      failure as fail-loud (rc=1, no CREATE fallback) so a raise here
      means no duplicates.

    Uses the default GH_TOKEN env (workflow GITHUB_TOKEN with
    `issues: write`); does NOT use PROJECT_TOKEN.
    """
    result = subprocess.run(
        ["gh", "issue", "list",
         "--repo", REPO,
         "--state", "all",
         "--search", 'in:title "Cycle "',
         "--json", "number,title,labels",
         "--limit", str(_BULK_FETCH_LIMIT)],
        capture_output=True, text=True, check=True,
    )
    items = json.loads(result.stdout)
    if len(items) >= _BULK_FETCH_LIMIT:
        # We may have truncated — refuse to proceed rather than mass-
        # duplicate via Phase A CREATE on the missing tail.
        raise RuntimeError(
            f"gh_fetch_all_cycle_trackers: returned {len(items)} items "
            f"which equals the limit {_BULK_FETCH_LIMIT}. The corpus has "
            f"likely outgrown the bulk-fetch ceiling. Raise _BULK_FETCH_LIMIT "
            f"or replace with proper pagination via gh api search/issues "
            f"--paginate before re-running the sync."
        )
    return items


def build_tracker_index(items: list[dict]) -> dict[str, tuple[int, str, list[str]]]:
    """Build a `{cycle_id → (number, title, labels)}` index from bulk-fetch output.

    Matches the same title shapes that `gh_find_existing_tracker` used to
    match per-cycle:
      "Cycle <id>"              (exact, no suffix — no-frontmatter docs)
      "Cycle <id>: <suffix>"    (canonical)
      "Cycle <id> <suffix>"     (space-followed legacy form)

    Anchoring: `Cycle 318: Foo` does NOT match a lookup for `318.1`. The
    cycle ID is parsed off the title text *after* the literal "Cycle "
    prefix using a regex that captures up to the next delimiter (`:`,
    space, or end-of-string).

    On duplicate cycle IDs in the issue corpus (two trackers with the
    same cycle ID — should not happen, but tolerate it), the FIRST
    occurrence wins. Same behaviour as the pre-bulk-fetch code, which
    returned the first match in the search-result order.
    """
    # Parse the cycle ID out of "Cycle <id>" or "Cycle <id>: …" or "Cycle <id> …".
    # Use a positive look-around for the delimiter so we don't consume it.
    # The id pattern allows dotted forms (1.2.3) — same shape parse_cycle_id_from_filename
    # accepts, but read from title rather than filename.
    title_id_re = re.compile(r"^Cycle (\d+(?:\.\d+)*)(?=$|:|\s)")
    index: dict[str, tuple[int, str, list[str]]] = {}
    for item in items:
        title = item.get("title", "") or ""
        m = title_id_re.match(title)
        if not m:
            continue
        cycle_id = m.group(1)
        if cycle_id in index:
            continue  # first occurrence wins (matches pre-bulk-fetch behaviour)
        label_names = [lbl["name"] for lbl in item.get("labels", []) or []]
        index[cycle_id] = (item["number"], title, label_names)
    return index


def gh_find_existing_tracker(
    cycle_id: str,
    index: Optional[dict[str, tuple[int, str, list[str]]]] = None,
) -> Optional[tuple[int, str, list[str]]]:
    """Return (number, title, labels) for an existing tracker matching the cycle ID, regardless of label.

    Matches on exact title (no suffix) OR exact title prefix:
      "Cycle <id>"             (whole title — produced when frontmatter
                                lacks `title:`; default is f"Cycle {id}")
      "Cycle <id>: "           (canonical title)
      "Cycle <id> "            (space-followed legacy form)
      (anchored — `Cycle 318` does NOT match `Cycle 318.1` lookups by
      design; we check exact-equality and prefix-with-delimiter only).
    Returns the first match (any state, any label).

    This is the adoption hook: cycles like 324.3 (#1414) and 330.2 (#1539)
    have manually-created trackers with the wrong labels. We find them
    regardless of label so we can relabel rather than duplicate-create.

    The exact-equality case is load-bearing for idempotency on the
    no-frontmatter path: cycle83 has no frontmatter, so plan_operations
    produces title `"Cycle 83"` exactly; if this lookup didn't handle
    that, the first sync would create the issue, the second sync would
    fail to find it (prefix-mismatch), and create a duplicate.

    Issue #1998 (2026-05): prefer the `index` kwarg over the per-cycle
    fallback. `execute()` calls `gh_fetch_all_cycle_trackers()` once at
    the top, then passes the resulting index here for in-memory lookups,
    eliminating the per-cycle search-API hits that triggered secondary
    rate-limiting (surfacing as HTTP 401). The legacy per-cycle search
    branch is preserved as a fallback for callers that don't pass an
    index — useful for ad-hoc CLI use and to keep the original test
    coverage meaningful.
    """
    if index is not None:
        return index.get(cycle_id)

    # Fallback: legacy per-cycle search. Kept for ad-hoc use and existing
    # test coverage. NOT used by execute() any more.
    # Search by title prefix; gh's --search uses GitHub's issue-search
    # tokenizer which doesn't honor exact phrase quoting reliably, so
    # post-filter the results.
    search_title = f"Cycle {cycle_id}"
    result = subprocess.run(
        ["gh", "issue", "list",
         "--repo", REPO,
         "--state", "all",
         "--search", f'in:title "{search_title}"',
         "--json", "number,title,labels",
         "--limit", "100"],
        capture_output=True, text=True, check=True,
    )
    items = json.loads(result.stdout)
    exact = f"Cycle {cycle_id}"
    prefix_colon = f"Cycle {cycle_id}: "
    prefix_space = f"Cycle {cycle_id} "
    for item in items:
        title = item.get("title", "")
        if (title == exact
                or title.startswith(prefix_colon)
                or title.startswith(prefix_space)):
            label_names = [lbl["name"] for lbl in item.get("labels", []) or []]
            return (item["number"], title, label_names)
    return None


def gh_add_label_to_issue(issue_number: int, label: str) -> None:
    """Add a label to an existing issue. Idempotent (gh issue edit
    silently accepts already-present labels)."""
    subprocess.run(
        ["gh", "issue", "edit", str(issue_number),
         "--repo", REPO,
         "--add-label", label],
        check=True, capture_output=True,
    )


def gh_node_id_for_issue(issue_number: int) -> str:
    result = subprocess.run(
        ["gh", "api",
         f"repos/{REPO}/issues/{issue_number}",
         "--jq", ".node_id"],
        capture_output=True, text=True, check=True,
    )
    return result.stdout.strip()


def gh_add_to_project(issue_number: int) -> None:
    """Add an issue to project #2 on momentiq-ai. Idempotent.

    Uses PROJECT_TOKEN (org-level Projects v2 mutation).
    """
    subprocess.run(
        ["gh", "project", "item-add", str(PROJECT_NUMBER),
         "--owner", PROJECT_OWNER,
         "--url", f"https://github.com/{REPO}/issues/{issue_number}"],
        check=True, capture_output=True, env=_project_env(),
    )


def gh_link_sub_issue(parent_issue_number: int, child_issue_number: int) -> None:
    """Wire a sub-issue parent/child relationship via GraphQL."""
    parent_node = gh_node_id_for_issue(parent_issue_number)
    child_node = gh_node_id_for_issue(child_issue_number)
    mutation = (
        "mutation($parent: ID!, $child: ID!) { "
        "addSubIssue(input: {issueId: $parent, subIssueId: $child}) { "
        "  issue { id } subIssue { id } "
        "} }"
    )
    subprocess.run(
        ["gh", "api", "graphql",
         "-f", f"query={mutation}",
         "-f", f"parent={parent_node}",
         "-f", f"child={child_node}"],
        capture_output=True, text=True, check=True,
    )


def gh_get_sub_issue_parent_number(child_issue_number: int) -> Optional[int]:
    """Return the parent issue number for a child sub-issue, or None.

    Used to verify idempotency of `addSubIssue` failures (Codex P2 review
    on PR for #1998): GitHub returns the same conjunctive error message
    ("Issue may not contain duplicate sub-issues and Sub issue may only
    have one parent") whether the child is already linked to the SAME
    parent we want (true idempotent success) or to a DIFFERENT parent
    (real error — would silently masquerade as success otherwise).

    Querying the parent lets us distinguish: same parent number → skip,
    different parent number → real failure.

    GraphQL: `Issue` has a `parent` field (the parent sub-issue), returning
    the parent Issue node. The `number` is the issue number we compare.
    Returns None if the child has no parent.

    Uses the default GH_TOKEN env (workflow GITHUB_TOKEN with
    `issues: read`); does NOT use PROJECT_TOKEN.
    """
    query = (
        "query($owner: String!, $repo: String!, $number: Int!) { "
        "repository(owner: $owner, name: $repo) { "
        "  issue(number: $number) { parent { number } } "
        "} }"
    )
    owner, _, repo = REPO.partition("/")
    result = subprocess.run(
        ["gh", "api", "graphql",
         "-f", f"query={query}",
         "-f", f"owner={owner}",
         "-f", f"repo={repo}",
         "-F", f"number={child_issue_number}"],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(result.stdout)
    parent = (
        data.get("data", {})
            .get("repository", {})
            .get("issue", {})
            .get("parent")
    )
    if not parent:
        return None
    parent_num = parent.get("number")
    return int(parent_num) if parent_num is not None else None


def is_already_linked_subissue_error(stderr: str) -> bool:
    """Return True only for explicit addSubIssue idempotency errors.

    These are the GitHub API responses we want to treat as success because
    the desired post-condition (parent ↔ child link) is already satisfied:

      - "already linked" / "already exists" / "already a sub-issue" / etc.
        — older / hypothetical wording, kept defensively.
      - "Issue may not contain duplicate sub-issues" / "Sub issue may only
        have one parent" — the EXACT GraphQL error strings GitHub returns
        today (2026-05) when addSubIssue is called against an already-wired
        relationship. Without these, the script counted ~24 cycles as
        failures on every run even though their links were correct
        (idempotency bug #1999, masked by #1998 until the rate-limit fix).
    """
    normalized = " ".join(stderr.lower().split())
    already_linked_phrases = (
        "already linked",
        "already exists",
        "already exist",
        "already a sub-issue",
        "already a subissue",
        "already added as a sub-issue",
        "already added as a subissue",
        "already has a parent",
        # Real-corpus addSubIssue idempotency errors (issue #1999). These
        # are GH-specific phrases bound to addSubIssue's stderr — chosen
        # narrow enough that they don't false-positive on unrelated
        # "parent issue may only have one parent" wording from other
        # surfaces (e.g., a future validation error against an orphan).
        # The first phrase includes "issue" to anchor it; the second
        # includes "sub issue" (GitHub's two-word spelling).
        "issue may not contain duplicate sub-issues",
        "sub issue may only have one parent",
    )
    return any(phrase in normalized for phrase in already_linked_phrases)


def get_project_metadata() -> dict:
    """Fetch project node ID, item IDs by issue number, and field metadata.

    Uses PROJECT_TOKEN for all calls (org-level Projects v2 read).

    Returns:
      {
        "project_id": "PVT_...",
        "field_ids": {field_name: field_id},
        "field_options": {field_name: {option_name: option_id}},
        "item_ids": {issue_number: item_id},
      }
    """
    proj_env = _project_env()
    fields_result = subprocess.run(
        ["gh", "project", "field-list", str(PROJECT_NUMBER),
         "--owner", PROJECT_OWNER, "--format", "json"],
        capture_output=True, text=True, check=True, env=proj_env,
    )
    fields_data = json.loads(fields_result.stdout)

    field_ids = {}
    field_options: dict[str, dict[str, str]] = {}
    for f in fields_data["fields"]:
        field_ids[f["name"]] = f["id"]
        if "options" in f:
            field_options[f["name"]] = {opt["name"]: opt["id"] for opt in f["options"]}

    items_result = subprocess.run(
        ["gh", "project", "item-list", str(PROJECT_NUMBER),
         "--owner", PROJECT_OWNER, "--format", "json", "--limit", "1000"],
        capture_output=True, text=True, check=True, env=proj_env,
    )
    items_data = json.loads(items_result.stdout)

    item_ids = {}
    for item in items_data["items"]:
        if item.get("content", {}).get("number"):
            item_ids[item["content"]["number"]] = item["id"]

    # Resolve project_id via repositoryOwner GraphQL
    pid_result = subprocess.run(
        ["gh", "api", "graphql",
         "-f", f"query=query{{ organization(login:\"{PROJECT_OWNER}\"){{ projectV2(number:{PROJECT_NUMBER}){{ id }} }} }}"],
        capture_output=True, text=True, check=True, env=proj_env,
    )
    pid_data = json.loads(pid_result.stdout)
    project_id = pid_data["data"]["organization"]["projectV2"]["id"]

    return {
        "project_id": project_id,
        "field_ids": field_ids,
        "field_options": field_options,
        "item_ids": item_ids,
    }


def gh_set_field_single_select(project_id: str, item_id: str, field_id: str,
                                option_id: str) -> None:
    subprocess.run(
        ["gh", "project", "item-edit",
         "--project-id", project_id,
         "--id", item_id,
         "--field-id", field_id,
         "--single-select-option-id", option_id],
        check=True, capture_output=True, env=_project_env(),
    )


def gh_set_field_text(project_id: str, item_id: str, field_id: str,
                       text: str) -> None:
    subprocess.run(
        ["gh", "project", "item-edit",
         "--project-id", project_id,
         "--id", item_id,
         "--field-id", field_id,
         "--text", text],
        check=True, capture_output=True, env=_project_env(),
    )


def populate_fields_for_cycle(op: dict, issue_number: int, meta: dict) -> bool:
    """Set Item Type / Wave / Priority / Cycle Doc on the tracker issue's project item.

    All values come from the doc's frontmatter (read once by plan_operations).
    `Cycle Doc` is derived from the doc PATH, not from a frontmatter key.
    `Sister Cycle` / `Manifesto refs` are not populated (no frontmatter source);
    leave them at whatever value an operator set manually.
    """
    cycle_id = op["cycle_id"]
    frontmatter = op["frontmatter"]
    item_id = meta["item_ids"].get(issue_number)
    if not item_id:
        print(f"[fields ERROR] #{issue_number} ({cycle_id}) — not on project; skip")
        return False
    project_id = meta["project_id"]
    field_ids = meta["field_ids"]
    field_options = meta["field_options"]

    item_type = "Sub-Cycle" if op["parent_cycle"] else "Cycle"
    type_opt = field_options.get("Item Type", {}).get(item_type)
    if type_opt and "Item Type" in field_ids:
        gh_set_field_single_select(project_id, item_id, field_ids["Item Type"], type_opt)

    wave = frontmatter.get("wave")
    if wave is not None and "Wave" in field_ids:
        wave_opt = field_options.get("Wave", {}).get(str(wave))
        if wave_opt:
            gh_set_field_single_select(project_id, item_id, field_ids["Wave"], wave_opt)

    priority = frontmatter.get("priority")
    if priority and "Priority" in field_ids:
        # Frontmatter can be lowercase ("high", "medium", "low") or title-case
        # ("High", "Medium", "Low"). Project options are title-case.
        prio_normalized = str(priority).strip().strip("\"'").title()
        prio_opt = field_options.get("Priority", {}).get(prio_normalized)
        if prio_opt:
            gh_set_field_single_select(project_id, item_id, field_ids["Priority"], prio_opt)

    if "Cycle Doc" in field_ids:
        rel_doc_path = repo_relative_path(op["doc_path"]).as_posix()
        doc_url = f"https://github.com/{REPO}/blob/main/{rel_doc_path}"
        gh_set_field_text(project_id, item_id, field_ids["Cycle Doc"], doc_url)

    print(f"[fields] #{issue_number} ({cycle_id}) — Item Type={item_type}, "
          f"Wave={wave}, Priority={priority}")
    return True


# ─────────────────────────────────────────────────────────────────────────
# Orchestration
# ─────────────────────────────────────────────────────────────────────────


def execute(
    ops: list[dict],
    collisions: list[dict],
    dry_run: bool = False,
    issues_only: bool = False,
) -> int:
    """Execute the plan and return an exit code (0 = success, 1 = failures).

    Phases:
      A. Per-cycle: find-or-create tracker, adopt if mislabeled, add to project.
      B. Sub-issue parent links (skipped for orphan parents with a [warn]).
      C. Custom-field population (skipped in --issues-only mode).
    """
    cycle_to_issue: dict[str, int] = {}
    failures: list[tuple[str, str]] = []

    # Log collisions up front so operators see them before any creates.
    for c in collisions:
        canonical_name = c["canonical"].name
        other_names = ", ".join(p.name for p in c["others"])
        print(
            f"[collision] cycle {c['cycle_id']}: {len(c['others']) + 1} docs share this id; "
            f"canonical={canonical_name}; others=[{other_names}]"
        )

    # Bulk-fetch every cycle-tracker issue in ONE search call up front
    # (issue #1998 fix). Pre-bulk-fetch, every cycle did its own
    # `gh issue list --search` — ~300 hits/run against the search API,
    # ~18% returned `HTTP 401: Bad credentials` from secondary rate
    # limiting. One bulk call has no rate-limit pressure.
    tracker_index: Optional[dict[str, tuple[int, str, list[str]]]] = None
    if not dry_run:
        try:
            tracker_index = build_tracker_index(gh_fetch_all_cycle_trackers())
            print(f"[bulk-fetch] indexed {len(tracker_index)} existing cycle tracker(s)")
        except (subprocess.CalledProcessError, RuntimeError) as e:
            # If the one bulk call fails OR returns a truncated set, we
            # cannot proceed — every cycle would CREATE-duplicate. Fail
            # loud and exit non-zero. This is explicitly NOT a per-cycle
            # fallback to the search API.
            err_msg = e.stderr.strip() if isinstance(e, subprocess.CalledProcessError) and e.stderr else str(e)
            print(f"[error] bulk tracker fetch failed: {err_msg}")
            failures.append(("*", f"bulk tracker fetch failed: {err_msg}"))
            return 1

    # Phase A — per-cycle find / create / adopt
    for op in ops:
        cycle_id = op["cycle_id"]
        title = op["title"]
        if dry_run:
            existing_hint = "?"  # hermetic — don't call gh
            print(f"[dry-run] cycle {cycle_id}: would create-or-adopt — title='{title}' label={op['label']}")
            if op["parent_cycle"]:
                if op["parent_doc_exists"]:
                    print(f"[dry-run] cycle {cycle_id}: would link to parent {op['parent_cycle']}")
                else:
                    print(
                        f"[warn] parent {op['parent_cycle']} has no cycle doc; "
                        f"sub-issue link skipped for {cycle_id}"
                    )
            continue

        try:
            existing = gh_find_existing_tracker(cycle_id, index=tracker_index)
        except subprocess.CalledProcessError as e:
            failures.append((cycle_id, f"tracker lookup failed: {(e.stderr or '').strip()}"))
            print(f"[error] cycle {cycle_id}: tracker lookup failed: {(e.stderr or '').strip()}")
            continue

        if existing:
            issue_num, existing_title, existing_labels = existing
            has_correct_label = op["label"] in existing_labels
            if has_correct_label:
                print(f"[skip] cycle {cycle_id}: #{issue_num} '{existing_title}' already correctly labeled ({op['label']})")
            else:
                # ADOPT: add the missing type:cycle/type:sub-cycle label.
                try:
                    gh_add_label_to_issue(issue_num, op["label"])
                    print(
                        f"[adopt] cycle {cycle_id}: #{issue_num} '{existing_title}' "
                        f"— added label {op['label']} "
                        f"(was: {existing_labels or 'no labels'})"
                    )
                except subprocess.CalledProcessError as e:
                    failures.append((cycle_id, f"label-add failed: {(e.stderr or '').strip()}"))
                    print(f"[error] cycle {cycle_id}: label-add failed: {(e.stderr or '').strip()}")
                    continue
            cycle_to_issue[cycle_id] = issue_num
            try:
                gh_add_to_project(issue_num)
            except subprocess.CalledProcessError as e:
                # Adding to project is idempotent at the GraphQL layer but
                # gh project item-add returns nonzero on dup sometimes — don't fail
                # the whole sync over it.
                msg = (e.stderr or '').strip().lower()
                if "already" not in msg:
                    print(f"[warn] cycle {cycle_id}: project add failed (non-fatal): {(e.stderr or '').strip()}")
            continue

        # CREATE
        try:
            issue_num = gh_create_issue(title=title, body=op["body"], label=op["label"])
            cycle_to_issue[cycle_id] = issue_num
            print(f"[create] cycle {cycle_id}: #{issue_num} '{title}' (label={op['label']})")
            gh_add_to_project(issue_num)
        except subprocess.CalledProcessError as e:
            failures.append((cycle_id, f"create failed: {(e.stderr or '').strip()}"))
            print(f"[error] cycle {cycle_id}: create failed: {(e.stderr or '').strip()}")
            continue

    # Phase B — sub-issue parent links
    for op in ops:
        cycle_id = op["cycle_id"]
        parent_id = op["parent_cycle"]
        if not parent_id:
            continue

        # Orphan-parent fail-soft: skip the link silently apart from a warn line.
        if not op["parent_doc_exists"]:
            if dry_run:
                # Already printed during Phase A dry-run; avoid duplication.
                continue
            print(
                f"[warn] parent {parent_id} has no cycle doc; "
                f"sub-issue link skipped for {cycle_id}"
            )
            continue

        if dry_run:
            continue  # printed in Phase A

        child_num = cycle_to_issue.get(cycle_id)
        parent_num = cycle_to_issue.get(parent_id)
        if child_num is None or parent_num is None:
            print(
                f"[warn] cycle {cycle_id}: cannot link to parent {parent_id} — "
                f"missing tracker issue (child#={child_num}, parent#={parent_num})"
            )
            continue

        try:
            gh_link_sub_issue(parent_num, child_num)
            print(f"[link] #{child_num} (cycle {cycle_id}) → parent #{parent_num} (cycle {parent_id})")
        except subprocess.CalledProcessError as e:
            stderr = e.stderr or ""
            if is_already_linked_subissue_error(stderr):
                # Codex P2 review on PR for #1998: GitHub returns the same
                # conjunctive error ("Issue may not contain duplicate
                # sub-issues and Sub issue may only have one parent")
                # whether the child is already linked to the SAME parent
                # we want (true idempotency) or to a DIFFERENT parent (real
                # error — wiring drift). Verify the current parent matches
                # before downgrading to skip-link.
                try:
                    current_parent_num = gh_get_sub_issue_parent_number(child_num)
                except subprocess.CalledProcessError as verify_err:
                    # If the verification call itself fails, treat as a
                    # real error (fail-safe — don't paper over).
                    print(
                        f"[error-link] cycle {cycle_id} → cycle {parent_id}: "
                        f"addSubIssue reported already-linked; parent verification "
                        f"failed: {(verify_err.stderr or '').strip()}"
                    )
                    failures.append((
                        cycle_id,
                        f"sub-issue link failed (parent verification unavailable): {stderr.strip()}",
                    ))
                    continue
                if current_parent_num == parent_num:
                    print(
                        f"[skip-link] cycle {cycle_id} → cycle {parent_id} "
                        f"(already linked to intended parent #{parent_num})"
                    )
                else:
                    print(
                        f"[error-link] cycle {cycle_id} → cycle {parent_id}: "
                        f"child #{child_num} is linked to a DIFFERENT parent "
                        f"#{current_parent_num} (intended #{parent_num}); "
                        f"manual repair required"
                    )
                    failures.append((
                        cycle_id,
                        f"sub-issue link drift: child #{child_num} linked to "
                        f"parent #{current_parent_num}, intended #{parent_num}",
                    ))
            else:
                print(f"[error-link] cycle {cycle_id} → cycle {parent_id}: {stderr.strip()}")
                failures.append((cycle_id, f"sub-issue link failed: {stderr.strip()}"))

    # Phase C — custom-field population
    if not issues_only and not dry_run:
        if not cycle_to_issue:
            print("[fields] no trackers resolved; skipping field population")
        else:
            try:
                meta = get_project_metadata()
            except subprocess.CalledProcessError as e:
                print(f"[error] project metadata fetch failed: {(e.stderr or '').strip()}")
                failures.append(("*", f"project metadata fetch failed: {(e.stderr or '').strip()}"))
                meta = None

            if meta:
                for op in ops:
                    cycle_id = op["cycle_id"]
                    issue_num = cycle_to_issue.get(cycle_id)
                    if not issue_num:
                        continue
                    try:
                        if not populate_fields_for_cycle(op, issue_num, meta):
                            failures.append((cycle_id, f"field population failed for #{issue_num}"))
                    except subprocess.CalledProcessError as e:
                        print(f"[error] cycle {cycle_id}: field set failed: {(e.stderr or '').strip()}")
                        failures.append((cycle_id, f"field set failed: {(e.stderr or '').strip()}"))

    if failures:
        print(f"\n[summary] {len(failures)} failure(s):")
        for cycle, reason in failures:
            print(f"  - cycle {cycle}: {reason}")
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="Hermetic: print planned ops without invoking gh.")
    parser.add_argument("--issues-only", action="store_true",
                        help="Skip Phase C (project field population); only "
                             "ensure trackers exist, are correctly labeled, "
                             "and wired into sub-issue trees.")
    parser.add_argument("--cycles-dir", type=Path, default=None,
                        help="Cycle docs directory (defaults to "
                             "docs/roadmap/cycles relative to cwd).")
    args = parser.parse_args()

    grouped = discover_cycle_docs(cycles_dir=args.cycles_dir)
    parent_doc_exists_lookup = {cid: True for cid in grouped.keys()}
    ops, collisions = plan_operations(grouped, parent_doc_exists_lookup)
    return execute(ops, collisions, dry_run=args.dry_run, issues_only=args.issues_only)


if __name__ == "__main__":
    sys.exit(main())
