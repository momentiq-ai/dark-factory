"""Tests for scripts/ci/sync_cycle_trackers.py.

Cycle 326 — supersedes test_backfill_cycle_issues.py. Coverage areas:
  - Cycle-ID parsing from filename (dotted, single-segment, underscore,
    dash-replaces-dot legacy variants)
  - Glob-based doc discovery (archive/ excluded)
  - Frontmatter parsing (parent_cycle, supersededBy / superseded_by)
  - Canonical-doc-per-cycle-ID selection (cycle 308 supersededBy
    regression covered explicitly)
  - Parent resolution (explicit > filename inference)
  - Orphan-parent fail-soft (label correctly, skip addSubIssue, warn)
  - Adoption (existing same-title issue with wrong label gets relabeled)
  - Duplicate cycle ID collisions logged but not double-tracked
  - Idempotency (re-runs skip correctly-shaped trackers)
  - --dry-run hermetic (no gh calls)
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import sync_cycle_trackers as sct  # noqa: E402
from sync_cycle_trackers import (  # noqa: E402
    build_issue_body,
    build_tracker_index,
    discover_cycle_docs,
    execute,
    is_already_linked_subissue_error,
    is_superseded,
    parse_cycle_id_from_filename,
    parse_frontmatter,
    plan_operations,
    repo_relative_path,
    resolve_parent,
    select_canonical_doc,
)


# ─────────────────────────────────────────────────────────────────────────
# parse_cycle_id_from_filename — cycle ID extraction from filename
# ─────────────────────────────────────────────────────────────────────────


class TestParseCycleIdFromFilename:
    def test_dotted_with_slug(self):
        assert parse_cycle_id_from_filename("cycle318.4-foo.md") == "318.4"

    def test_dotted_no_slug(self):
        assert parse_cycle_id_from_filename("cycle318.4.md") == "318.4"

    def test_multi_dot(self):
        assert parse_cycle_id_from_filename("cycle322.7.1-quorum.md") == "322.7.1"

    def test_single_segment_with_slug(self):
        assert parse_cycle_id_from_filename("cycle100-foo.md") == "100"

    def test_single_segment_no_slug(self):
        assert parse_cycle_id_from_filename("cycle100.md") == "100"

    def test_legacy_underscore(self):
        # cycle10_meta_learning.md → "10" (real corpus case)
        assert parse_cycle_id_from_filename("cycle10_meta_learning.md") == "10"

    def test_legacy_dash_replaces_dot(self):
        # cycle308-2-foo.md → "308.2" (real corpus case)
        assert parse_cycle_id_from_filename("cycle308-2-foo.md") == "308.2"

    def test_legacy_dash_replaces_dot_with_long_slug(self):
        assert parse_cycle_id_from_filename(
            "cycle308-3-auto-seed-mastery-on-domain-change.md"
        ) == "308.3"

    def test_non_cycle_filename(self):
        assert parse_cycle_id_from_filename("README.md") is None
        assert parse_cycle_id_from_filename("foo.md") is None
        assert parse_cycle_id_from_filename("cycle.md") is None


# ─────────────────────────────────────────────────────────────────────────
# discover_cycle_docs — glob-based discovery with archive exclusion
# ─────────────────────────────────────────────────────────────────────────


class TestDiscoverCycleDocs:
    def _write_doc(self, path: Path, frontmatter: str = "") -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        text = f"---\n{frontmatter}\n---\n# body\n" if frontmatter else "# body (no fm)\n"
        path.write_text(text)
        return path

    def test_discovers_basic_cycle_doc(self, tmp_path: Path):
        cycles_dir = tmp_path / "docs" / "roadmap" / "cycles"
        self._write_doc(cycles_dir / "cycle100-foo.md", "title: 'Cycle 100: Foo'")
        grouped = discover_cycle_docs(cycles_dir=cycles_dir, root=tmp_path)
        assert "100" in grouped
        assert grouped["100"] == [cycles_dir / "cycle100-foo.md"]

    def test_groups_duplicates(self, tmp_path: Path):
        cycles_dir = tmp_path / "docs" / "roadmap" / "cycles"
        self._write_doc(cycles_dir / "cycle309.5-grade-level-inventory.md", "title: 'Inv'")
        self._write_doc(cycles_dir / "cycle309.5-grade-level-retirement.md", "title: 'Ret'")
        grouped = discover_cycle_docs(cycles_dir=cycles_dir, root=tmp_path)
        assert "309.5" in grouped
        assert len(grouped["309.5"]) == 2

    def test_excludes_archive(self, tmp_path: Path):
        cycles_dir = tmp_path / "docs" / "roadmap" / "cycles"
        self._write_doc(cycles_dir / "cycle100-foo.md", "")
        self._write_doc(cycles_dir / "archive" / "cycle99-old.md", "")
        grouped = discover_cycle_docs(cycles_dir=cycles_dir, root=tmp_path)
        assert "100" in grouped
        assert "99" not in grouped

    def test_handles_legacy_naming_styles(self, tmp_path: Path):
        cycles_dir = tmp_path / "docs" / "roadmap" / "cycles"
        self._write_doc(cycles_dir / "cycle10_meta_learning.md", "")
        self._write_doc(cycles_dir / "cycle308-3-auto-seed.md", "")
        self._write_doc(cycles_dir / "cycle100-foo.md", "")
        grouped = discover_cycle_docs(cycles_dir=cycles_dir, root=tmp_path)
        assert "10" in grouped       # underscore-style
        assert "308.3" in grouped    # dash-replaces-dot
        assert "100" in grouped      # standard


# ─────────────────────────────────────────────────────────────────────────
# is_superseded — frontmatter superseded detection
# ─────────────────────────────────────────────────────────────────────────


class TestIsSuperseded:
    def test_status_superseded(self):
        assert is_superseded({"status": "superseded"})
        assert is_superseded({"status": "SUPERSEDED"})
        assert is_superseded({"status": '"superseded"'})

    def test_supersededby_camel_case_truthy(self):
        assert is_superseded({"supersededBy": "cycle308-student-edit.md"})

    def test_superseded_by_snake_case_truthy(self):
        assert is_superseded({"superseded_by": "cycle47-parent-cognitive-chat"})

    def test_supersededby_int_truthy(self):
        # Real corpus: cycle207.1 has `supersededBy: 316` (int)
        assert is_superseded({"supersededBy": 316})

    def test_supersededby_null_not_superseded(self):
        assert not is_superseded({"supersededBy": None})
        assert not is_superseded({"supersededBy": ""})
        assert not is_superseded({"supersededBy": "null"})
        assert not is_superseded({"supersededBy": "none"})

    def test_empty_frontmatter(self):
        assert not is_superseded({})


# ─────────────────────────────────────────────────────────────────────────
# select_canonical_doc — canonical-doc-per-cycle-ID priority order
# ─────────────────────────────────────────────────────────────────────────


def _make_doc(tmp_path: Path, filename: str, frontmatter: dict) -> Path:
    cycles_dir = tmp_path / "cycles"
    cycles_dir.mkdir(exist_ok=True)
    path = cycles_dir / filename
    fm_lines = []
    for k, v in frontmatter.items():
        if v is None:
            fm_lines.append(f"{k}: null")
        elif isinstance(v, str):
            fm_lines.append(f'{k}: "{v}"')
        else:
            fm_lines.append(f"{k}: {v}")
    path.write_text("---\n" + "\n".join(fm_lines) + "\n---\n# body\n")
    return path


class TestSelectCanonicalDoc:
    def test_single_doc_passes_through(self, tmp_path: Path):
        doc = _make_doc(tmp_path, "cycle100-foo.md", {"status": "draft"})
        canonical, collisions = select_canonical_doc("100", [doc])
        assert canonical == doc
        assert collisions == []

    def test_supersededby_filter_picks_unsuperseded(self, tmp_path: Path):
        """Real-corpus regression: cycle 308.

        cycle308-student-edit-page.md has status:completed AND
        supersededBy: 'cycle308-student-edit.md'; longer filename.
        cycle308-student-edit.md has status:completed, no supersededBy;
        shorter filename.

        Without the supersededBy filter, longest-filename would pick the
        WRONG doc. With the filter, the unsuperseded doc wins.
        """
        superseded = _make_doc(
            tmp_path,
            "cycle308-student-edit-page.md",
            {"status": "completed", "supersededBy": "cycle308-student-edit.md"},
        )
        canonical_target = _make_doc(
            tmp_path,
            "cycle308-student-edit.md",
            {"status": "completed"},
        )
        canonical, collisions = select_canonical_doc(
            "308", [superseded, canonical_target]
        )
        assert canonical == canonical_target, (
            "supersededBy filter MUST run before longest-filename tiebreaker"
        )
        assert collisions == [superseded]

    def test_superseded_by_snake_case_filter(self, tmp_path: Path):
        """Same as above but with the snake_case spelling of the key."""
        superseded = _make_doc(
            tmp_path,
            "cycle13_authentication_refactoring.md",
            {"status": "completed", "superseded_by": "../../ADR/2026-04-foo.md"},
        )
        canonical_target = _make_doc(
            tmp_path,
            "cycle13-foo.md",
            {"status": "draft"},
        )
        canonical, collisions = select_canonical_doc(
            "13", [superseded, canonical_target]
        )
        assert canonical == canonical_target
        assert collisions == [superseded]

    def test_in_progress_preferred_over_draft(self, tmp_path: Path):
        in_prog = _make_doc(
            tmp_path, "cycle100-short.md", {"status": "in-progress"}
        )
        draft_longer = _make_doc(
            tmp_path, "cycle100-much-longer-name.md", {"status": "draft"}
        )
        canonical, collisions = select_canonical_doc(
            "100", [in_prog, draft_longer]
        )
        assert canonical == in_prog
        assert collisions == [draft_longer]

    def test_longest_filename_tiebreaker(self, tmp_path: Path):
        short = _make_doc(tmp_path, "cycle100-foo.md", {"status": "draft"})
        long_ = _make_doc(
            tmp_path, "cycle100-much-longer-slug.md", {"status": "draft"}
        )
        canonical, collisions = select_canonical_doc("100", [short, long_])
        assert canonical == long_
        assert collisions == [short]

    def test_alphabetical_final_tiebreaker(self, tmp_path: Path):
        """Same length, same status, different alphabetic position."""
        a = _make_doc(tmp_path, "cycle100-aaa-foo.md", {"status": "draft"})
        b = _make_doc(tmp_path, "cycle100-bbb-foo.md", {"status": "draft"})
        canonical, collisions = select_canonical_doc("100", [a, b])
        # Per sort key (-len(name), name) — ascending name = "cycle100-aaa-foo.md" first.
        assert canonical == a
        assert collisions == [b]


# ─────────────────────────────────────────────────────────────────────────
# resolve_parent — explicit → filename inference fallback
# ─────────────────────────────────────────────────────────────────────────


class TestResolveParent:
    def test_explicit_parent_wins(self):
        assert resolve_parent("322.3.1", {"parent_cycle": 322}) == "322"
        # String form also works
        assert resolve_parent("322.3.1", {"parent_cycle": "322"}) == "322"

    def test_inference_when_explicit_missing(self):
        # 322.7.1 → 322.7 (minus last dot segment)
        assert resolve_parent("322.7.1", {}) == "322.7"

    def test_inference_two_segments(self):
        assert resolve_parent("318.4", {}) == "318"

    def test_top_level_returns_none(self):
        assert resolve_parent("100", {}) is None

    def test_explicit_null_falls_through_to_inference(self):
        assert resolve_parent("318.4", {"parent_cycle": None}) == "318"
        assert resolve_parent("318.4", {"parent_cycle": "null"}) == "318"
        assert resolve_parent("318.4", {"parent_cycle": ""}) == "318"

    def test_top_level_explicit_null_stays_none(self):
        assert resolve_parent("100", {"parent_cycle": None}) is None

    def test_float_parent_safe(self):
        # YAML might parse `parent_cycle: 322.7` as float 322.7 — must still work.
        assert resolve_parent("322.7.1", {"parent_cycle": 322.7}) == "322.7"


# ─────────────────────────────────────────────────────────────────────────
# plan_operations — assembly of per-cycle ops with label / parent / collisions
# ─────────────────────────────────────────────────────────────────────────


class TestPlanOperations:
    """plan_operations() reaches into build_issue_body() → repo_relative_path()
    which is anchored at cwd. The tests use monkeypatch.chdir(tmp_path) so the
    fixture docs are "under the repo root" from the function's POV.
    """

    def test_top_level_gets_type_cycle(self, tmp_path: Path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        doc = _make_doc(tmp_path, "cycle100-foo.md", {"title": "Cycle 100: Foo"})
        grouped = {"100": [doc]}
        ops, collisions = plan_operations(grouped, {"100": True})
        assert len(ops) == 1
        assert ops[0]["cycle_id"] == "100"
        assert ops[0]["label"] == "type:cycle"
        assert ops[0]["parent_cycle"] is None
        assert collisions == []

    def test_sub_cycle_with_explicit_parent_gets_type_sub_cycle(
        self, tmp_path: Path, monkeypatch
    ):
        monkeypatch.chdir(tmp_path)
        doc = _make_doc(
            tmp_path,
            "cycle100.1-foo.md",
            {"title": "Cycle 100.1: Foo", "parent_cycle": 100},
        )
        grouped = {"100.1": [doc]}
        ops, _ = plan_operations(grouped, {"100.1": True, "100": True})
        assert ops[0]["label"] == "type:sub-cycle"
        assert ops[0]["parent_cycle"] == "100"
        assert ops[0]["parent_doc_exists"] is True

    def test_sub_cycle_with_inferred_parent_gets_type_sub_cycle(
        self, tmp_path: Path, monkeypatch
    ):
        monkeypatch.chdir(tmp_path)
        doc = _make_doc(
            tmp_path, "cycle322.7.1-foo.md", {"title": "Cycle 322.7.1: Foo"}
        )
        grouped = {"322.7.1": [doc]}
        ops, _ = plan_operations(grouped, {"322.7.1": True, "322.7": True})
        assert ops[0]["label"] == "type:sub-cycle"
        assert ops[0]["parent_cycle"] == "322.7"
        assert ops[0]["parent_doc_exists"] is True

    def test_orphan_parent_fail_soft(self, tmp_path: Path, monkeypatch):
        """Cycle 177.1 has inferred parent 177; no cycle177*.md exists.

        Label must be type:sub-cycle (intent), but parent_doc_exists=False
        so the sub-issue wiring skips with a [warn].
        """
        monkeypatch.chdir(tmp_path)
        doc = _make_doc(
            tmp_path,
            "cycle177.1-chat-delight-canvas.md",
            {"title": "Cycle 177.1: Chat Delight"},
        )
        grouped = {"177.1": [doc]}  # NO 177 in grouped
        ops, _ = plan_operations(grouped, {"177.1": True})
        assert ops[0]["label"] == "type:sub-cycle"
        assert ops[0]["parent_cycle"] == "177"
        assert ops[0]["parent_doc_exists"] is False

    def test_duplicate_cycle_id_collision_logged(self, tmp_path: Path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        a = _make_doc(
            tmp_path,
            "cycle308-student-edit-page.md",
            {
                "title": "Cycle 308: Edit (page, superseded)",
                "status": "completed",
                "supersededBy": "cycle308-student-edit.md",
            },
        )
        b = _make_doc(
            tmp_path,
            "cycle308-student-edit.md",
            {"title": "Cycle 308: Edit", "status": "completed"},
        )
        grouped = {"308": [a, b]}
        ops, collisions = plan_operations(grouped, {"308": True})
        assert len(ops) == 1
        assert ops[0]["doc_path"] == b  # canonical = unsuperseded
        assert len(collisions) == 1
        assert collisions[0]["cycle_id"] == "308"
        assert collisions[0]["canonical"] == b
        assert collisions[0]["others"] == [a]


# ─────────────────────────────────────────────────────────────────────────
# execute — dry-run, adoption, idempotency, orphan-parent
# ─────────────────────────────────────────────────────────────────────────


class TestExecuteDryRun:
    def test_dry_run_is_hermetic(self, monkeypatch, capsys):
        """Dry-run must NOT call any gh helper."""
        called: list = []
        monkeypatch.setattr(
            sct, "gh_find_existing_tracker",
            lambda cycle_id: called.append(("find", cycle_id)) or None,
        )
        monkeypatch.setattr(
            sct, "gh_create_issue", lambda **kw: called.append(kw) or 9999,
        )
        monkeypatch.setattr(
            sct, "gh_add_to_project", lambda issue_number: called.append(("add", issue_number)),
        )
        monkeypatch.setattr(
            sct, "gh_link_sub_issue",
            lambda parent_id, child_id: called.append(("link", parent_id, child_id)),
        )
        monkeypatch.setattr(
            sct, "gh_add_label_to_issue",
            lambda i, l: called.append(("label", i, l)),
        )

        ops = [
            {
                "cycle_id": "100",
                "title": "Cycle 100: Parent",
                "body": "body",
                "label": "type:cycle",
                "parent_cycle": None,
                "parent_doc_exists": False,
                "doc_path": Path("cycle100-foo.md"),
                "frontmatter": {},
            },
            {
                "cycle_id": "100.1",
                "title": "Cycle 100.1: Child",
                "body": "body",
                "label": "type:sub-cycle",
                "parent_cycle": "100",
                "parent_doc_exists": True,
                "doc_path": Path("cycle100.1-bar.md"),
                "frontmatter": {},
            },
        ]
        rc = execute(ops, collisions=[], dry_run=True)
        assert rc == 0
        assert called == [], f"Dry-run called gh helpers: {called}"
        captured = capsys.readouterr()
        assert "[dry-run] cycle 100:" in captured.out
        assert "[dry-run] cycle 100.1:" in captured.out
        assert "would link to parent 100" in captured.out

    def test_dry_run_warns_for_orphan_parent(self, capsys):
        ops = [
            {
                "cycle_id": "177.1",
                "title": "Cycle 177.1: Foo",
                "body": "body",
                "label": "type:sub-cycle",
                "parent_cycle": "177",
                "parent_doc_exists": False,   # orphan
                "doc_path": Path("cycle177.1-foo.md"),
                "frontmatter": {},
            },
        ]
        rc = execute(ops, collisions=[], dry_run=True)
        assert rc == 0
        out = capsys.readouterr().out
        assert "[warn] parent 177 has no cycle doc" in out
        assert "sub-issue link skipped for 177.1" in out

    def test_dry_run_prints_collisions_first(self, capsys):
        ops = []
        collisions = [
            {
                "cycle_id": "308",
                "canonical": Path("cycle308-student-edit.md"),
                "others": [Path("cycle308-student-edit-page.md")],
            }
        ]
        rc = execute(ops, collisions=collisions, dry_run=True)
        assert rc == 0
        out = capsys.readouterr().out
        assert "[collision] cycle 308" in out
        assert "canonical=cycle308-student-edit.md" in out
        assert "cycle308-student-edit-page.md" in out


class TestExecuteAdoption:
    """Adoption path — existing same-title issue gets relabeled."""

    def _op(self, **overrides):
        base = {
            "cycle_id": "324.3",
            "title": "Cycle 324.3: IB MYP family — meta + 8 subject groups",
            "body": "body",
            "label": "type:sub-cycle",
            "parent_cycle": "324",
            "parent_doc_exists": True,
            "doc_path": Path("cycle324.3-foo.md"),
            "frontmatter": {"wave": 8, "priority": "high"},
        }
        base.update(overrides)
        return base

    def test_existing_with_wrong_label_gets_adopted(self, monkeypatch, capsys):
        """Real-corpus regression: #1414 has title prefix 'Cycle 324.3'
        but label 'tech debt' instead of 'type:sub-cycle'."""
        # Bulk-fetch returns an issue matching cycle 324.3 with the wrong label.
        monkeypatch.setattr(
            sct,
            "gh_fetch_all_cycle_trackers",
            lambda: [
                {"number": 1414,
                 "title": "Cycle 324.3: IB MYP family — meta + 8 subject groups",
                 "labels": [{"name": "tech debt"}]},
            ],
        )
        labels_added: list[tuple[int, str]] = []
        added_to_project: list[int] = []
        monkeypatch.setattr(
            sct,
            "gh_add_label_to_issue",
            lambda issue_number, label: labels_added.append((issue_number, label)),
        )
        monkeypatch.setattr(
            sct,
            "gh_add_to_project",
            lambda issue_number: added_to_project.append(issue_number),
        )
        # Block Phase B (sub-issue link) since parent tracker might not exist;
        # we're just testing adoption here. Phase B will check parent_doc_exists
        # then look up parent tracker — easier to stub gh_link_sub_issue.
        monkeypatch.setattr(sct, "gh_link_sub_issue", lambda p, c: None)

        # Use --issues-only so Phase C doesn't try to fetch project metadata.
        rc = execute([self._op()], collisions=[], dry_run=False, issues_only=True)
        assert rc == 0
        assert labels_added == [(1414, "type:sub-cycle")]
        assert added_to_project == [1414]
        out = capsys.readouterr().out
        assert "[adopt] cycle 324.3: #1414" in out

    def test_existing_with_correct_label_is_skipped(self, monkeypatch, capsys):
        """Idempotency: re-running over a correctly-labeled tracker is a no-op."""
        monkeypatch.setattr(
            sct,
            "gh_fetch_all_cycle_trackers",
            lambda: [
                {"number": 1339, "title": "Cycle 318: Foo",
                 "labels": [{"name": "type:cycle"}]},
            ],
        )
        labels_added: list = []
        monkeypatch.setattr(
            sct,
            "gh_add_label_to_issue",
            lambda issue_number, label: labels_added.append((issue_number, label)),
        )
        added_to_project: list[int] = []
        monkeypatch.setattr(
            sct,
            "gh_add_to_project",
            lambda issue_number: added_to_project.append(issue_number),
        )

        op = self._op(cycle_id="318", title="Cycle 318: Foo", label="type:cycle",
                       parent_cycle=None, parent_doc_exists=False)
        rc = execute([op], collisions=[], dry_run=False, issues_only=True)
        assert rc == 0
        assert labels_added == []   # already correctly labeled
        # Still re-adds to project (idempotent repair)
        assert added_to_project == [1339]
        out = capsys.readouterr().out
        assert "[skip] cycle 318: #1339" in out
        assert "already correctly labeled" in out


class TestExecuteOrphanParent:
    """Orphan-parent fail-soft: skip addSubIssue, emit warn."""

    def test_orphan_parent_skips_link(self, monkeypatch, capsys):
        """Cycle 177.1 has parent 177 but no 177 cycle doc."""
        # CREATE path: empty bulk-fetch index → tracker lookup returns None.
        monkeypatch.setattr(sct, "gh_fetch_all_cycle_trackers", lambda: [])
        created_issues: list[tuple[str, str, str]] = []
        monkeypatch.setattr(
            sct,
            "gh_create_issue",
            lambda title, body, label: (
                created_issues.append((title, body, label)) or 5000
            ),
        )
        added_to_project: list[int] = []
        monkeypatch.setattr(
            sct,
            "gh_add_to_project",
            lambda issue_number: added_to_project.append(issue_number),
        )
        # gh_link_sub_issue MUST NOT be called
        link_calls: list = []
        monkeypatch.setattr(
            sct,
            "gh_link_sub_issue",
            lambda parent, child: link_calls.append((parent, child)),
        )

        op = {
            "cycle_id": "177.1",
            "title": "Cycle 177.1: Foo",
            "body": "body",
            "label": "type:sub-cycle",
            "parent_cycle": "177",
            "parent_doc_exists": False,  # orphan
            "doc_path": Path("cycle177.1-foo.md"),
            "frontmatter": {},
        }
        rc = execute([op], collisions=[], dry_run=False, issues_only=True)
        assert rc == 0
        assert link_calls == [], f"addSubIssue called for orphan parent: {link_calls}"
        out = capsys.readouterr().out
        assert "[warn] parent 177 has no cycle doc" in out


# ─────────────────────────────────────────────────────────────────────────
# Existing-behavior carryovers (kept from test_backfill_cycle_issues.py)
# ─────────────────────────────────────────────────────────────────────────


def test_build_issue_body_uses_absolute_blob_url(tmp_path: Path, monkeypatch):
    cycles_dir = tmp_path / "docs" / "roadmap" / "cycles"
    cycles_dir.mkdir(parents=True)
    doc_path = cycles_dir / "cycle318.4-foo.md"
    doc_path.write_text("---\ntitle: 'foo'\n---\nbody")
    monkeypatch.chdir(tmp_path)

    body = build_issue_body(
        cycle_id="318.4",
        doc_path=doc_path,
        frontmatter={"status": "draft", "wave": 8, "priority": "high"},
    )

    assert (
        "https://github.com/momentiq-ai/sage3c/blob/main/"
        "docs/roadmap/cycles/cycle318.4-foo.md"
    ) in body
    assert "**Status**: draft" in body
    assert "**Wave**: 8" in body
    assert "**Priority**: high" in body


def test_repo_relative_path_rejects_paths_outside_root(tmp_path: Path):
    external = tmp_path / "elsewhere" / "cycle318.4-foo.md"
    external.parent.mkdir()
    external.write_text("---\n---\n")
    with pytest.raises(ValueError, match="not under repository root"):
        repo_relative_path(external, root=tmp_path / "repo")


def test_already_linked_subissue_error_detection_is_explicit():
    assert is_already_linked_subissue_error(
        "GraphQL: sub-issue already exists for this issue"
    )
    assert is_already_linked_subissue_error(
        "GraphQL: this issue is already a sub-issue of that parent"
    )
    assert not is_already_linked_subissue_error(
        "GraphQL: addSubIssue failed because subIssueId is invalid"
    )
    assert not is_already_linked_subissue_error(
        "GraphQL: subissue mutation rate limited"
    )


def test_already_linked_detects_real_github_addsubissue_errors():
    """Regression test for issue #1999.

    These are the actual stderr strings GitHub returns from `gh api graphql`
    when addSubIssue is called against an already-wired relationship — the
    desired post-condition (parent ↔ child) is already satisfied, so the
    script MUST treat them as success rather than aggregating as failures.

    The script was running for 10+ days marking ~24 cycles as failed on
    every run because these phrases weren't in the idempotency list.
    """
    # First half of the real error: duplicate sub-issue on the parent.
    assert is_already_linked_subissue_error(
        "gh: An error occured while adding the sub-issue to the parent issue. "
        "Issue may not contain duplicate sub-issues and Sub issue may only have one parent"
    )
    # Just the second half — same error text from a slightly different
    # phrasing where the parent already has a different child.
    assert is_already_linked_subissue_error(
        "Error: Sub issue may only have one parent"
    )
    # Case-insensitive match.
    assert is_already_linked_subissue_error(
        "ISSUE MAY NOT CONTAIN DUPLICATE SUB-ISSUES"
    )


def test_already_linked_does_not_overmatch_unrelated_parent_errors():
    """The 'one parent' phrase must NOT swallow unrelated wording.

    Codex review (PR for #1998/#1999): the broader substring
    'may only have one parent' could match validation errors from other
    surfaces (e.g., generic 'parent issue may only have one parent for
    orphan adoption'). The match is anchored on 'sub issue may only have
    one parent' — GitHub's specific two-word spelling — to avoid that
    class of false positive.
    """
    # NOT an addSubIssue idempotency error — should fail.
    assert not is_already_linked_subissue_error(
        "Validation: parent issue may only have one parent in this view"
    )
    assert not is_already_linked_subissue_error(
        "Some other API: an item may only have one parent assigned"
    )
    # The standalone 'may not contain duplicate' phrase from a non-issue
    # surface (e.g., a label-set error) must also not match — anchored.
    assert not is_already_linked_subissue_error(
        "Label set may not contain duplicate sub-issues entries"
    )


def test_parse_frontmatter_returns_empty_on_malformed(tmp_path: Path):
    doc = tmp_path / "cycle100-foo.md"
    doc.write_text("no frontmatter")
    assert parse_frontmatter(doc) == {}

    doc.write_text("---\nnot: closed properly\n# body")
    assert parse_frontmatter(doc) == {}


# ─────────────────────────────────────────────────────────────────────────
# Disambiguation — gh_find_existing_tracker prefix matching
# ─────────────────────────────────────────────────────────────────────────


def test_dotted_lookup_does_not_match_318_for_318_1(monkeypatch):
    """gh_find_existing_tracker('318.1') must NOT return a tracker
    titled 'Cycle 318: Foo'.

    Exact prefix match required: 'Cycle 318.1: ' or 'Cycle 318.1 '
    — not the bare 'Cycle 318'.
    """
    # Simulate gh issue list returning Cycle 318 (without .1) — common
    # when searching by token because GitHub search splits on punctuation.
    class _Result:
        stdout = '[{"number": 1339, "title": "Cycle 318: Foo", "labels": []}]'
        stderr = ""
        returncode = 0

    def fake_run(*a, **kw):
        return _Result()

    monkeypatch.setattr(sct.subprocess, "run", fake_run)
    result = sct.gh_find_existing_tracker("318.1")
    assert result is None, (
        f"Expected no match for 318.1 against 'Cycle 318: Foo' but got {result}"
    )


def test_dotted_lookup_does_match_exact_prefix(monkeypatch):
    """Conversely, an exact-prefix match MUST succeed."""
    class _Result:
        stdout = (
            '[{"number": 1414, "title": "Cycle 324.3: IB MYP family — meta + 8 subject groups", "labels": [{"name": "tech debt"}]}]'
        )
        stderr = ""
        returncode = 0

    def fake_run(*a, **kw):
        return _Result()

    monkeypatch.setattr(sct.subprocess, "run", fake_run)
    result = sct.gh_find_existing_tracker("324.3")
    assert result is not None
    issue_num, title, labels = result
    assert issue_num == 1414
    assert "Cycle 324.3:" in title
    assert labels == ["tech debt"]


def test_exact_title_match_for_no_frontmatter_doc(monkeypatch):
    """When a doc has no `title:` frontmatter, plan_operations defaults
    to f"Cycle {cycle_id}" (no colon, no suffix). On second sync, the
    lookup must match the just-created issue's title exactly, or the
    script will create a duplicate. Regression test for cycle 83 case
    (and any future no-frontmatter doc)."""
    class _Result:
        stdout = '[{"number": 9001, "title": "Cycle 83", "labels": []}]'
        stderr = ""
        returncode = 0

    def fake_run(*a, **kw):
        return _Result()

    monkeypatch.setattr(sct.subprocess, "run", fake_run)
    result = sct.gh_find_existing_tracker("83")
    assert result is not None, (
        "Expected to match the exact title 'Cycle 83' (idempotency requirement "
        "for no-frontmatter docs); got None"
    )
    issue_num, title, labels = result
    assert issue_num == 9001
    assert title == "Cycle 83"


# ─────────────────────────────────────────────────────────────────────────
# Bulk-fetch + index (issue #1998)
# ─────────────────────────────────────────────────────────────────────────


class TestBuildTrackerIndex:
    """build_tracker_index parses cycle IDs out of issue titles.

    The shapes we MUST recognize match what plan_operations produces:
      'Cycle 9'                                — no-frontmatter doc
      'Cycle 12: Foo bar'                      — canonical
      'Cycle 308 — Edit (legacy space form)'   — pre-canonical legacy form
      'Cycle 322.7.1: Quorum'                  — multi-dot
    """

    def test_recognizes_canonical_titles(self):
        items = [
            {"number": 100, "title": "Cycle 12: Foo", "labels": []},
            {"number": 101, "title": "Cycle 322.7.1: Quorum", "labels": [{"name": "type:sub-cycle"}]},
        ]
        idx = build_tracker_index(items)
        assert idx["12"] == (100, "Cycle 12: Foo", [])
        assert idx["322.7.1"] == (101, "Cycle 322.7.1: Quorum", ["type:sub-cycle"])

    def test_recognizes_exact_title_no_suffix(self):
        """Cycle 83 — no frontmatter title, just 'Cycle 83'."""
        items = [{"number": 9001, "title": "Cycle 83", "labels": []}]
        idx = build_tracker_index(items)
        assert idx["83"] == (9001, "Cycle 83", [])

    def test_recognizes_space_followed_legacy(self):
        items = [{"number": 200, "title": "Cycle 178 — Old Naming", "labels": []}]
        idx = build_tracker_index(items)
        assert idx["178"] == (200, "Cycle 178 — Old Naming", [])

    def test_ignores_non_cycle_titles(self):
        items = [
            {"number": 300, "title": "Random issue, mentions Cycle 12 in body", "labels": []},
            {"number": 301, "title": "[cycle] feedback investigator failures", "labels": []},
            {"number": 302, "title": "Cycle Tracker Sync flakes", "labels": []},
            # Real-corpus collision: a PR title was indexed by search;
            # we must reject titles that don't start with a digit after "Cycle ".
            {"number": 303, "title": "Cycle: notes on adoption", "labels": []},
        ]
        idx = build_tracker_index(items)
        assert idx == {}

    def test_first_occurrence_wins_on_duplicate(self):
        """Two trackers for the same cycle ID — first wins (matches
        pre-bulk-fetch search-order behaviour)."""
        items = [
            {"number": 1, "title": "Cycle 100: First", "labels": []},
            {"number": 2, "title": "Cycle 100: Duplicate", "labels": []},
        ]
        idx = build_tracker_index(items)
        assert idx["100"] == (1, "Cycle 100: First", [])

    def test_318_does_not_swallow_318_1(self):
        """Anchoring contract: bulk-fetch must mirror the legacy
        per-cycle behaviour where 'Cycle 318: Foo' does NOT match a
        lookup for 318.1."""
        items = [
            {"number": 100, "title": "Cycle 318: Foo", "labels": []},
            {"number": 101, "title": "Cycle 318.1: Bar", "labels": []},
        ]
        idx = build_tracker_index(items)
        assert idx["318"] == (100, "Cycle 318: Foo", [])
        assert idx["318.1"] == (101, "Cycle 318.1: Bar", [])
        assert idx.get("3181") is None

    def test_handles_empty_or_missing_title(self):
        items = [
            {"number": 1, "title": "", "labels": []},
            {"number": 2, "labels": []},  # no title field
            {"number": 3, "title": None, "labels": []},
        ]
        idx = build_tracker_index(items)
        assert idx == {}


def test_gh_find_existing_tracker_prefers_index(monkeypatch):
    """When an index is passed, gh_find_existing_tracker MUST NOT call
    subprocess at all — that was the entire point of bulk-fetch (issue #1998).
    """
    called: list = []

    def fake_run(*a, **kw):
        called.append((a, kw))
        raise AssertionError("subprocess.run must NOT be called when index is provided")

    monkeypatch.setattr(sct.subprocess, "run", fake_run)
    index = {"324.3": (1414, "Cycle 324.3: IB MYP", ["tech debt"])}
    result = sct.gh_find_existing_tracker("324.3", index=index)
    assert result == (1414, "Cycle 324.3: IB MYP", ["tech debt"])
    assert called == []

    # And the miss path also must not subprocess.
    miss = sct.gh_find_existing_tracker("999.999", index=index)
    assert miss is None
    assert called == []


def test_execute_uses_bulk_fetch_and_does_not_call_per_cycle_search(monkeypatch, capsys):
    """End-to-end: execute() makes ONE bulk-fetch call and then does
    in-memory lookups. Regression guard for issue #1998 — if a future
    refactor reintroduces the per-cycle search, this test catches it.
    """
    bulk_calls: list = []
    per_cycle_lookups: list = []
    add_to_project_calls: list = []

    def fake_bulk_fetch():
        bulk_calls.append("called")
        # Two existing trackers in the index — one correctly labeled
        # (skip path), one mislabeled (adopt path).
        return [
            {"number": 1500, "title": "Cycle 100: Already-correct", "labels": [{"name": "type:cycle"}]},
            {"number": 1501, "title": "Cycle 200: Needs-adoption", "labels": [{"name": "tech debt"}]},
        ]

    monkeypatch.setattr(sct, "gh_fetch_all_cycle_trackers", fake_bulk_fetch)

    # Make the legacy per-cycle subprocess path raise so the test FAILS
    # loudly if execute() ever falls back to it.
    def fake_run(*a, **kw):
        per_cycle_lookups.append((a, kw))
        raise AssertionError(
            "execute() must not invoke subprocess.run for per-cycle searches "
            "(issue #1998 fix); use the bulk-fetch index"
        )

    monkeypatch.setattr(sct.subprocess, "run", fake_run)

    # Stub the side-effectful gh helpers — none of these should hit
    # subprocess because we monkeypatched them, but the stubs verify
    # the right path is taken.
    labels_added: list = []
    monkeypatch.setattr(
        sct, "gh_add_label_to_issue",
        lambda issue_number, label: labels_added.append((issue_number, label)),
    )
    monkeypatch.setattr(
        sct, "gh_add_to_project",
        lambda issue_number: add_to_project_calls.append(issue_number),
    )
    monkeypatch.setattr(sct, "gh_link_sub_issue", lambda p, c: None)

    ops = [
        {
            "cycle_id": "100",
            "title": "Cycle 100: Already-correct",
            "body": "body",
            "label": "type:cycle",
            "parent_cycle": None,
            "parent_doc_exists": False,
            "doc_path": Path("cycle100-foo.md"),
            "frontmatter": {},
        },
        {
            "cycle_id": "200",
            "title": "Cycle 200: Needs-adoption",
            "body": "body",
            "label": "type:cycle",
            "parent_cycle": None,
            "parent_doc_exists": False,
            "doc_path": Path("cycle200-bar.md"),
            "frontmatter": {},
        },
    ]
    rc = sct.execute(ops, collisions=[], dry_run=False, issues_only=True)

    assert rc == 0
    assert bulk_calls == ["called"], "expected exactly one bulk-fetch call"
    assert per_cycle_lookups == [], "no per-cycle subprocess searches allowed"
    # Cycle 100 was correctly labeled → no adopt, just project-add.
    # Cycle 200 was mislabeled → adopt added the label, then project-add.
    assert labels_added == [(1501, "type:cycle")]
    assert set(add_to_project_calls) == {1500, 1501}

    out = capsys.readouterr().out
    assert "[bulk-fetch] indexed 2 existing cycle tracker(s)" in out
    assert "[skip] cycle 100: #1500" in out
    assert "[adopt] cycle 200: #1501" in out


def test_execute_bulk_fetch_failure_returns_nonzero_does_not_create_duplicates(monkeypatch, capsys):
    """If the bulk fetch fails (network, auth, etc.), execute() MUST NOT
    proceed to per-cycle CREATE — that would mass-duplicate every tracker
    in the corpus. The correct behaviour is fail loud, exit 1, do nothing.
    """
    create_calls: list = []
    monkeypatch.setattr(
        sct, "gh_create_issue",
        lambda **kw: create_calls.append(kw) or 9999,
    )

    def fake_bulk_fetch():
        raise subprocess.CalledProcessError(
            returncode=1,
            cmd=["gh", "issue", "list", "..."],
            stderr="HTTP 401: Bad credentials (https://api.github.com/graphql)",
        )

    monkeypatch.setattr(sct, "gh_fetch_all_cycle_trackers", fake_bulk_fetch)

    ops = [
        {
            "cycle_id": "100",
            "title": "Cycle 100: Foo",
            "body": "body",
            "label": "type:cycle",
            "parent_cycle": None,
            "parent_doc_exists": False,
            "doc_path": Path("cycle100-foo.md"),
            "frontmatter": {},
        },
    ]
    rc = sct.execute(ops, collisions=[], dry_run=False, issues_only=True)

    assert rc == 1
    assert create_calls == [], (
        "execute() must NOT call gh_create_issue when bulk-fetch fails — "
        "would mass-duplicate the entire tracker corpus"
    )
    out = capsys.readouterr().out
    assert "[error] bulk tracker fetch failed" in out


def test_gh_fetch_all_cycle_trackers_calls_gh_issue_list_once(monkeypatch):
    """Sanity-check the bulk-fetch shells out exactly once with the right shape."""
    calls: list = []

    class _Result:
        stdout = (
            '[{"number": 1, "title": "Cycle 1: Foo", "labels": []}, '
            '{"number": 2, "title": "Cycle 2: Bar", "labels": [{"name": "type:cycle"}]}]'
        )
        stderr = ""
        returncode = 0

    def fake_run(cmd, *a, **kw):
        calls.append(cmd)
        return _Result()

    monkeypatch.setattr(sct.subprocess, "run", fake_run)
    items = sct.gh_fetch_all_cycle_trackers()
    assert len(calls) == 1
    cmd = calls[0]
    assert cmd[0] == "gh" and cmd[1] == "issue" and cmd[2] == "list"
    assert "--search" in cmd
    # Verify we ask for enough items to cover the whole corpus + headroom.
    assert "--limit" in cmd
    limit_idx = cmd.index("--limit")
    assert int(cmd[limit_idx + 1]) >= 1000
    assert items[0]["number"] == 1
    assert items[1]["labels"][0]["name"] == "type:cycle"


def test_gh_fetch_all_cycle_trackers_raises_when_at_limit(monkeypatch):
    """Codex P1 review on PR for #1998 — if the bulk-fetch returns exactly
    `_BULK_FETCH_LIMIT` items, we cannot prove the response wasn't truncated.
    Raise rather than silently return a partial index, which would mass-
    duplicate via Phase A CREATE on the missing tail.
    """
    # Fabricate exactly _BULK_FETCH_LIMIT items.
    items = [
        {"number": i, "title": f"Cycle {i}: foo", "labels": []}
        for i in range(1, sct._BULK_FETCH_LIMIT + 1)
    ]

    class _Result:
        stdout = ""
        stderr = ""
        returncode = 0

        def __init__(self, payload):
            self.stdout = payload

    def fake_run(cmd, *a, **kw):
        import json as _json
        return _Result(_json.dumps(items))

    monkeypatch.setattr(sct.subprocess, "run", fake_run)
    with pytest.raises(RuntimeError, match="outgrown the bulk-fetch ceiling"):
        sct.gh_fetch_all_cycle_trackers()


def test_execute_bulk_fetch_at_limit_raises_returns_nonzero(monkeypatch, capsys):
    """If gh_fetch_all_cycle_trackers raises RuntimeError (corpus at limit),
    execute() returns rc=1 and does NOT call gh_create_issue."""
    create_calls: list = []
    monkeypatch.setattr(
        sct, "gh_create_issue",
        lambda **kw: create_calls.append(kw) or 9999,
    )

    def fake_bulk_fetch():
        raise RuntimeError(
            "gh_fetch_all_cycle_trackers: returned 5000 items which equals "
            "the limit 5000. The corpus has likely outgrown the bulk-fetch "
            "ceiling."
        )

    monkeypatch.setattr(sct, "gh_fetch_all_cycle_trackers", fake_bulk_fetch)

    ops = [
        {
            "cycle_id": "100",
            "title": "Cycle 100: Foo",
            "body": "body",
            "label": "type:cycle",
            "parent_cycle": None,
            "parent_doc_exists": False,
            "doc_path": Path("cycle100-foo.md"),
            "frontmatter": {},
        },
    ]
    rc = sct.execute(ops, collisions=[], dry_run=False, issues_only=True)
    assert rc == 1
    assert create_calls == []
    out = capsys.readouterr().out
    assert "[error] bulk tracker fetch failed" in out
    assert "outgrown the bulk-fetch ceiling" in out


def test_phase_b_link_idempotency_verifies_parent_matches(monkeypatch, capsys):
    """Codex P2 review on PR for #1998: when addSubIssue fails with the
    'already linked / one parent' conjunctive error, we must verify the
    child's current parent matches our intended parent BEFORE downgrading
    to [skip-link]. Same parent → skip; different parent → real error.

    This case: child is already linked to the SAME parent → skip is correct.
    """
    monkeypatch.setattr(sct, "gh_fetch_all_cycle_trackers", lambda: [])

    monkeypatch.setattr(
        sct, "gh_create_issue",
        lambda **kw: 5001 if "100.1" in kw["title"] else 5000,
    )
    monkeypatch.setattr(sct, "gh_add_to_project", lambda issue_number: None)

    def fake_link(parent, child):
        raise subprocess.CalledProcessError(
            returncode=1,
            cmd=["gh", "api", "graphql"],
            stderr=(
                "gh: An error occured while adding the sub-issue to the parent issue. "
                "Issue may not contain duplicate sub-issues and Sub issue may only have one parent"
            ),
        )

    monkeypatch.setattr(sct, "gh_link_sub_issue", fake_link)
    # Current parent is what we intended (#5000), so it's a true idempotent skip.
    monkeypatch.setattr(
        sct, "gh_get_sub_issue_parent_number",
        lambda child_num: 5000,
    )

    ops = [
        {"cycle_id": "100", "title": "Cycle 100: Parent",
         "body": "b", "label": "type:cycle",
         "parent_cycle": None, "parent_doc_exists": False,
         "doc_path": Path("cycle100.md"), "frontmatter": {}},
        {"cycle_id": "100.1", "title": "Cycle 100.1: Child",
         "body": "b", "label": "type:sub-cycle",
         "parent_cycle": "100", "parent_doc_exists": True,
         "doc_path": Path("cycle100.1.md"), "frontmatter": {}},
    ]
    rc = sct.execute(ops, collisions=[], dry_run=False, issues_only=True)
    assert rc == 0, "verified-same-parent idempotency must not aggregate as a failure"
    out = capsys.readouterr().out
    assert "[skip-link] cycle 100.1" in out
    assert "already linked to intended parent #5000" in out


def test_phase_b_link_idempotency_surfaces_drift_when_parent_differs(monkeypatch, capsys):
    """Same fixture as above, but the child is wired to a DIFFERENT parent
    than what we intend. This is real drift — must aggregate as a failure,
    NOT silently masquerade as success.
    """
    monkeypatch.setattr(sct, "gh_fetch_all_cycle_trackers", lambda: [])

    monkeypatch.setattr(
        sct, "gh_create_issue",
        lambda **kw: 5001 if "100.1" in kw["title"] else 5000,
    )
    monkeypatch.setattr(sct, "gh_add_to_project", lambda issue_number: None)

    def fake_link(parent, child):
        raise subprocess.CalledProcessError(
            returncode=1,
            cmd=["gh", "api", "graphql"],
            stderr=(
                "gh: An error occured while adding the sub-issue to the parent issue. "
                "Issue may not contain duplicate sub-issues and Sub issue may only have one parent"
            ),
        )

    monkeypatch.setattr(sct, "gh_link_sub_issue", fake_link)
    # Child is wired to a DIFFERENT parent (#9999), not our intended #5000.
    monkeypatch.setattr(
        sct, "gh_get_sub_issue_parent_number",
        lambda child_num: 9999,
    )

    ops = [
        {"cycle_id": "100", "title": "Cycle 100: Parent",
         "body": "b", "label": "type:cycle",
         "parent_cycle": None, "parent_doc_exists": False,
         "doc_path": Path("cycle100.md"), "frontmatter": {}},
        {"cycle_id": "100.1", "title": "Cycle 100.1: Child",
         "body": "b", "label": "type:sub-cycle",
         "parent_cycle": "100", "parent_doc_exists": True,
         "doc_path": Path("cycle100.1.md"), "frontmatter": {}},
    ]
    rc = sct.execute(ops, collisions=[], dry_run=False, issues_only=True)
    assert rc == 1, "drift to a different parent must surface as a failure"
    out = capsys.readouterr().out
    assert "linked to a DIFFERENT parent #9999" in out
    assert "intended #5000" in out
    assert "manual repair required" in out


def test_phase_b_link_idempotency_surfaces_error_when_verification_fails(monkeypatch, capsys):
    """If `gh_get_sub_issue_parent_number` itself errors out (transient
    API issue, etc.), we fail-safe — treat the link as a real error rather
    than papering over with a skip-link. The verification IS the safety
    net Codex P2 asked for; degrading to a skip on its failure would
    re-introduce the drift-as-success bug.
    """
    monkeypatch.setattr(sct, "gh_fetch_all_cycle_trackers", lambda: [])

    monkeypatch.setattr(
        sct, "gh_create_issue",
        lambda **kw: 5001 if "100.1" in kw["title"] else 5000,
    )
    monkeypatch.setattr(sct, "gh_add_to_project", lambda issue_number: None)

    def fake_link(parent, child):
        raise subprocess.CalledProcessError(
            returncode=1,
            cmd=["gh", "api", "graphql"],
            stderr="Issue may not contain duplicate sub-issues",
        )

    def fake_verify(child_num):
        raise subprocess.CalledProcessError(
            returncode=1,
            cmd=["gh", "api", "graphql"],
            stderr="HTTP 502: Bad Gateway",
        )

    monkeypatch.setattr(sct, "gh_link_sub_issue", fake_link)
    monkeypatch.setattr(sct, "gh_get_sub_issue_parent_number", fake_verify)

    ops = [
        {"cycle_id": "100", "title": "Cycle 100: Parent",
         "body": "b", "label": "type:cycle",
         "parent_cycle": None, "parent_doc_exists": False,
         "doc_path": Path("cycle100.md"), "frontmatter": {}},
        {"cycle_id": "100.1", "title": "Cycle 100.1: Child",
         "body": "b", "label": "type:sub-cycle",
         "parent_cycle": "100", "parent_doc_exists": True,
         "doc_path": Path("cycle100.1.md"), "frontmatter": {}},
    ]
    rc = sct.execute(ops, collisions=[], dry_run=False, issues_only=True)
    assert rc == 1
    out = capsys.readouterr().out
    assert "parent verification failed" in out


def test_gh_get_sub_issue_parent_number_returns_number(monkeypatch):
    """Sanity check the parent-of-child GraphQL query shape."""
    class _Result:
        stdout = '{"data":{"repository":{"issue":{"parent":{"number":1234}}}}}'
        stderr = ""
        returncode = 0

    def fake_run(*a, **kw):
        return _Result()

    monkeypatch.setattr(sct.subprocess, "run", fake_run)
    assert sct.gh_get_sub_issue_parent_number(5001) == 1234


def test_gh_get_sub_issue_parent_number_returns_none_when_no_parent(monkeypatch):
    class _Result:
        stdout = '{"data":{"repository":{"issue":{"parent":null}}}}'
        stderr = ""
        returncode = 0

    monkeypatch.setattr(sct.subprocess, "run", lambda *a, **kw: _Result())
    assert sct.gh_get_sub_issue_parent_number(5001) is None
