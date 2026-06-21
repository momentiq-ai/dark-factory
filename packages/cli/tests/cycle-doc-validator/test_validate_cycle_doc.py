"""Tests for scripts/ci/validate_cycle_doc.py.

Covers the four rule categories from Component 2 of
cycle318.4-ci-fallback-and-auto-merge.md:

  * Type detection (plan PR vs code PR)
  * Trailer parsing (Cycle:, Issue:, ProjectItem:, GitHub auto-close)
  * Code PR rules (Cycle required, Issue|ProjectItem required, cycle
    exists, status not completed/superseded)
  * Plan PR rules (Cycle required, cycle doc must be in diff)
  * Status-transition guard (no PR completes its own cited cycle)
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import textwrap

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import validate_cycle_doc as validator  # noqa: E402
from validate_cycle_doc import (  # noqa: E402
    CycleDoc,
    REPO_ROOT,
    _parse_paginated_commit_messages,
    build_trailer_input,
    find_cycle_doc,
    is_bot_exempt,
    is_plan_pr,
    normalize_cycle_id,
    parse_trailers,
    read_cycle_frontmatter_from_text,
    status_completion_in_diff,
    validate,
    validate_objectives,
)


# ---------------------------------------------------------------------------
# parse_trailers
# ---------------------------------------------------------------------------


def test_parse_trailers_extracts_cycle_and_issue():
    body = (
        "## Summary\n"
        "Adds the foo gate.\n\n"
        "Cycle: 318.4\n"
        "Issue: #1234\n"
    )
    out = parse_trailers(body)
    assert out.cycle == "318.4"
    assert out.issue == "#1234"
    assert out.project_item is None


def test_parse_trailers_recognizes_github_close_keywords_as_issue():
    body = "Some change\n\nCycle: 320\nCloses #999\n"
    out = parse_trailers(body)
    assert out.cycle == "320"
    assert out.issue == "#999"


def test_parse_trailers_handles_fixes_resolves_variations():
    for verb in ("fixes #1", "Fixed #2", "RESOLVES #3", "Resolved #4"):
        out = parse_trailers(f"Cycle: 100\n{verb}\n")
        assert out.issue is not None, f"missing issue match for {verb!r}"


def test_parse_trailers_explicit_issue_wins_over_autoclose():
    # An explicit ``Issue:`` trailer takes priority over autoclose.
    body = "Cycle: 318.4\nIssue: #42\nCloses #99\n"
    out = parse_trailers(body)
    assert out.issue == "#42"


def test_parse_trailers_captures_project_item():
    out = parse_trailers("Cycle: 318\nProjectItem: PVT_kwDOA-foo123\n")
    assert out.project_item == "PVT_kwDOA-foo123"


def test_parse_trailers_last_value_wins_for_duplicates():
    out = parse_trailers("Cycle: 318\nCycle: 319\n")
    assert out.cycle == "319"
    assert out.raw["cycle"] == ["318", "319"]


def test_read_cycle_frontmatter_from_text_matches_file_parser():
    text = """\
---
cycle: 999
status: superseded
superseded_by: 1000
---

# Body
"""
    assert read_cycle_frontmatter_from_text(text) == ("superseded", "1000")


# ---------------------------------------------------------------------------
# normalize_cycle_id
# ---------------------------------------------------------------------------


def test_normalize_cycle_id_accepts_dotted_decimal():
    assert normalize_cycle_id("318.4") == "318.4"
    assert normalize_cycle_id("318") == "318"
    assert normalize_cycle_id("1.2.3") == "1.2.3"


def test_normalize_cycle_id_strips_trailing_slug():
    assert normalize_cycle_id("318.4 — Dark Factory") == "318.4"
    assert normalize_cycle_id("320-foo") == "320"


def test_normalize_cycle_id_rejects_garbage():
    assert normalize_cycle_id("") is None
    assert normalize_cycle_id("not-a-number") is None


# ---------------------------------------------------------------------------
# is_plan_pr
# ---------------------------------------------------------------------------


def test_is_plan_pr_title_pattern_plus_docs_only():
    assert is_plan_pr(
        title="docs(roadmap): new cycle 999",
        labels=[],
        changed_files=["docs/roadmap/cycles/cycle999-foo.md"],
    )


def test_is_plan_pr_label_plus_docs_only():
    assert is_plan_pr(
        title="feat(999): cycle 999 plan",  # title doesn't match pattern
        labels=["plan-pr"],
        changed_files=["docs/roadmap/cycles/cycle999-foo.md"],
    )


def test_is_plan_pr_false_when_code_paths_present():
    # Title pattern matches but diff contains backend code → code PR.
    assert not is_plan_pr(
        title="docs(roadmap): cycle plan",
        labels=[],
        changed_files=["docs/roadmap/cycles/cycle999.md", "backend/app/api.py"],
    )


def test_is_plan_pr_false_when_no_signal():
    assert not is_plan_pr(
        title="feat: ship something",
        labels=["bug"],
        changed_files=["docs/roadmap/cycles/cycle999.md"],
    )


def test_is_plan_pr_false_when_no_changed_files_returned():
    # gh api outage path: empty changed_files should NOT classify as plan PR.
    assert not is_plan_pr(
        title="docs(roadmap): new cycle",
        labels=[],
        changed_files=[],
    )


def test_is_plan_pr_false_when_only_roadmap_index_edited():
    """Issue #25 regression: a PR that only edits the roadmap index/overview
    (e.g. ``docs/roadmap/roadmap-overview.md`` or
    ``docs/roadmap/dark-factory-roadmap.md``) is NOT a plan PR.

    Before the narrowing fix, the plan-PR classifier accepted any change
    confined to ``docs/`` when paired with a ``docs(roadmap):`` title or
    a ``plan-pr`` label. That forced consumers to manufacture a cycle
    doc + tracking issue for routine roadmap-index refreshes. The
    tightened contract: plan-PR detection requires that at least one
    changed file is itself a cycle doc under
    ``docs/roadmap/cycles/cycle*.md``.
    """
    assert not is_plan_pr(
        title="docs(roadmap): refresh statuses on the roadmap index",
        labels=[],
        changed_files=["docs/roadmap/dark-factory-roadmap.md"],
    )
    assert not is_plan_pr(
        title="docs(roadmap): drop stale columns",
        labels=["plan-pr"],
        changed_files=["docs/roadmap/roadmap-overview.md"],
    )


def test_is_plan_pr_true_when_cycle_doc_edited():
    """Plan-PR detection still fires when a real cycle doc is in the diff."""
    assert is_plan_pr(
        title="docs(roadmap): extract from sage3c",
        labels=[],
        changed_files=[
            "docs/roadmap/cycles/cycle331.1-extract-from-sage3c.md",
        ],
    )


def test_is_plan_pr_false_for_cycles_dir_readme():
    """The ``docs/roadmap/cycles/`` directory README is not a cycle doc.

    Only filenames matching ``cycle*.md`` count toward plan-PR
    classification — ``README.md`` (or any other non-cycle doc) sitting
    next to the cycle files is index/meta content and should route
    through the non-cycle PR contract.
    """
    assert not is_plan_pr(
        title="docs(roadmap): refresh cycles index",
        labels=[],
        changed_files=["docs/roadmap/cycles/README.md"],
    )


# ---------------------------------------------------------------------------
# status_completion_in_diff
# ---------------------------------------------------------------------------


def test_status_completion_in_diff_detects_added_status_completed():
    diff = """\
diff --git a/docs/roadmap/cycles/cycle999.md b/docs/roadmap/cycles/cycle999.md
--- a/docs/roadmap/cycles/cycle999.md
+++ b/docs/roadmap/cycles/cycle999.md
@@ -1,8 +1,8 @@
 ---
 cycle: 999
-status: in-progress
+status: completed
 ---
"""
    # Hunk-only diff without frontmatter fence boundaries — should still
    # detect the added status: completed line since we don't strictly
    # require seeing the fence in the diff itself.
    affected = status_completion_in_diff(diff)
    assert "docs/roadmap/cycles/cycle999.md" in affected


def test_status_completion_in_diff_ignores_non_cycle_paths():
    diff = """\
+++ b/backend/app/foo.py
+status: completed
"""
    assert status_completion_in_diff(diff) == []


def test_status_completion_in_diff_ignores_unchanged_completed_line():
    # A context line (space prefix, not +) should NOT be flagged.
    diff = """\
+++ b/docs/roadmap/cycles/cycle999.md
 status: completed
"""
    assert status_completion_in_diff(diff) == []


# ---------------------------------------------------------------------------
# _parse_paginated_commit_messages
# ---------------------------------------------------------------------------


def test_parse_paginated_single_page():
    """Single `gh api` page — one JSON array — should yield each commit body intact."""
    raw = (
        '[{"commit":{"message":"feat: add foo\\n\\nDetails about foo.\\n\\n'
        'Cycle: 999\\nIssue: #1\\n"}}, '
        '{"commit":{"message":"chore: bump dep\\n\\nCycle: 999\\n"}}]'
    )
    out = _parse_paginated_commit_messages(raw)
    # Both commit messages present, separated by blank lines, internal
    # blank lines preserved so parse_trailers sees the trailer block.
    assert "feat: add foo" in out
    assert "chore: bump dep" in out
    assert "Cycle: 999" in out
    # Trailers should be parseable
    trailers = parse_trailers(out)
    assert trailers.cycle == "999"
    assert trailers.issue == "#1"


def test_parse_paginated_multi_page_concatenated_arrays():
    """`gh api --paginate` concatenates arrays back-to-back. Streaming parse must handle that."""
    raw = (
        '[{"commit":{"message":"first commit\\n\\nCycle: 100\\n"}}]'
        '[{"commit":{"message":"second commit\\n\\nIssue: #5\\n"}},'
        ' {"commit":{"message":"third commit\\n\\nProjectItem: PVT_xyz\\n"}}]'
    )
    out = _parse_paginated_commit_messages(raw)
    assert "first commit" in out
    assert "second commit" in out
    assert "third commit" in out
    trailers = parse_trailers(out)
    # Last value wins for duplicate keys; should see all three trailers.
    assert trailers.cycle == "100"
    assert trailers.issue == "#5"
    assert trailers.project_item == "PVT_xyz"


def test_parse_paginated_preserves_multi_line_body():
    """Commit bodies span multiple lines; the parser must preserve them so trailer-block detection works.

    Previously the code line-flattened the stream with newline-split, which
    fragmented multi-line bodies and broke trailer parsing. The streaming
    `raw_decode` parser keeps each commit's full message intact.
    """
    msg = (
        "feat: do stuff\n"
        "\n"
        "Detailed paragraph 1 about why.\n"
        "Detailed paragraph 2 about how.\n"
        "\n"
        "Cycle: 318.4\n"
        "Issue: #9\n"
    )
    import json as _json

    raw = _json.dumps([{"commit": {"message": msg}}])
    out = _parse_paginated_commit_messages(raw)
    assert out.rstrip() == msg.rstrip(), "multi-line body was not preserved verbatim"


def test_parse_paginated_empty_input():
    assert _parse_paginated_commit_messages("") == ""
    assert _parse_paginated_commit_messages("   \n  ") == ""


def test_parse_paginated_garbage_input_returns_empty():
    """Non-JSON input must not raise; returns empty string for graceful degradation."""
    # No JSON anywhere. The parser walks 1 byte at a time looking for a
    # JSON object; with no valid JSON it exits cleanly with an empty result.
    assert _parse_paginated_commit_messages("not json at all").strip() == ""


def test_parse_paginated_single_commit_dict_payload():
    """Defensive — single-commit dict (not array) should also be honored."""
    raw = '{"commit":{"message":"only commit\\n\\nCycle: 1\\n"}}'
    out = _parse_paginated_commit_messages(raw)
    assert "only commit" in out
    assert parse_trailers(out).cycle == "1"


# ---------------------------------------------------------------------------
# build_trailer_input — PR body precedence
# ---------------------------------------------------------------------------


def test_build_trailer_input_pr_body_overrides_stale_early_commit():
    """A correct Cycle: in PR body must win over a stale Cycle: on an early commit.

    Reproduces the failure mode the precedence rule fixes: PR description
    cites the right cycle while an early commit message (older in
    chronological order) carries a stale value. Without precedence,
    parse_trailers picks the LAST seen value — which would be the stale
    early commit, because the older commits used to come after the body
    in the concatenation. The fix puts PR body last.
    """
    pr_body = "## Summary\n\nReal change.\n\nCycle: 318.4\nIssue: #100\n"
    # Two commits — early commit has STALE cycle (stuck from a rebase),
    # tip commit has no Cycle: trailer at all.
    commits = (
        "early: WIP\n\nCycle: 999\nIssue: #50\n"
        "\n\n"
        "tip: final commit\n\nNo trailer on tip.\n"
    )
    out = build_trailer_input(pr_body, commits)
    trailers = parse_trailers(out)
    assert trailers.cycle == "318.4", (
        f"PR body should win; got cycle={trailers.cycle!r}\nbody:\n{out}"
    )
    # Issue from body wins too — the early commit's #50 should not bleed through.
    assert trailers.issue == "#100"


def test_build_trailer_input_uses_tip_when_body_absent():
    """If PR body has no Cycle: but tip commit does, tip wins."""
    pr_body = "## Summary\n\nNo trailers in body.\n"
    commits = (
        "early: WIP\n\nNo trailer here.\n"
        "\n\n"
        "tip: final commit\n\nCycle: 320\nIssue: #5\n"
    )
    out = build_trailer_input(pr_body, commits)
    trailers = parse_trailers(out)
    assert trailers.cycle == "320"
    assert trailers.issue == "#5"


def test_build_trailer_input_falls_through_to_earlier_commits():
    """If neither body nor tip has the trailer, an early commit's value is picked up."""
    pr_body = "Body without trailers.\n"
    commits = "first: stuff\n\nCycle: 100\n\n\nsecond: stuff\n\nNo cycle here.\n"
    out = build_trailer_input(pr_body, commits)
    assert parse_trailers(out).cycle == "100"


def test_build_trailer_input_no_commits_returns_body_unchanged():
    body = "Just the body.\nCycle: 1\n"
    assert build_trailer_input(body, "") == body
    assert build_trailer_input(body, "   ") == body
    assert build_trailer_input(body, []) == body


def test_build_trailer_input_list_preserves_blank_paragraphs_in_bodies():
    """Regression: a commit body with its own blank-line paragraph must
    not be re-split as if it were two commits. Previously the string-
    joined form aliased the inter-commit "\\n\\n" delimiter and split a
    multi-paragraph body, so the "tip commit" became the second
    paragraph of an older commit instead of the actual tip.

    The list-of-strings shape avoids the ambiguity entirely; the test
    pins the contract.
    """
    early = (
        "early commit subject\n"
        "\n"
        "First paragraph of an explanation.\n"
        "\n"
        "Second paragraph — this used to be misread as a separate commit.\n"
    )
    tip = "tip commit subject\n\nCycle: 318.4\nIssue: #1\n"
    pr_body = ""

    out = build_trailer_input(pr_body, [early, tip])
    trailers = parse_trailers(out)
    # The tip's trailers are picked up authoritatively. If the function
    # had mis-split the early commit's blank-line paragraph as a
    # separate commit and treated it as the "tip", the second paragraph
    # ("this used to be misread...") would be parsed last and `cycle`
    # would be None.
    assert trailers.cycle == "318.4"
    assert trailers.issue == "#1"


def test_pr_commit_messages_returns_list():
    """Top-level type contract: pr_commit_messages returns list[str]."""
    from validate_cycle_doc import _parse_paginated_commits_to_list

    raw = (
        '[{"commit":{"message":"first\\n\\nbody\\n"}},'
        '{"commit":{"message":"second\\n"}}]'
    )
    assert _parse_paginated_commits_to_list(raw) == ["first\n\nbody", "second"]
    assert _parse_paginated_commits_to_list("") == []


# ---------------------------------------------------------------------------
# validate (end-to-end against real cycle docs in this repo)
# ---------------------------------------------------------------------------


def test_validate_code_pr_happy_path_with_issue_trailer():
    """Cycle 318.4 is in-progress; cite it with Cycle: + Issue:; should pass."""
    errors = validate(
        title="feat(318.4): wire CI gates",
        body="Cycle: 318.4\nIssue: #1234\n",
        labels=[],
        changed_files=["scripts/ci/validate_cycle_doc.py"],
        diff="",
    )
    assert errors == [], f"unexpected errors: {errors}"


def test_validate_code_pr_happy_path_with_autoclose_keyword():
    errors = validate(
        title="feat(318.4): ship X",
        body="Implements stuff.\n\nCloses #1234\nCycle: 318.4\n",
        labels=[],
        changed_files=["scripts/ci/foo.py"],
        diff="",
    )
    assert errors == [], f"unexpected errors: {errors}"


def test_validate_code_pr_with_autoclose_but_no_cycle_is_non_cycle_pr():
    """CONTRIBUTING.md non-cycle PR: `Closes #N` alone (no Cycle:) is valid."""
    errors = validate(
        title="feat: random",
        body="No trailers here.\nCloses #1234\n",  # has issue, no cycle
        labels=[],
        changed_files=["backend/app/api.py"],
        diff="",
    )
    assert errors == [], f"non-cycle PR with autoclose should pass: {errors}"


def test_validate_code_pr_missing_issue_and_project_item_fails():
    errors = validate(
        title="feat(318.4): something",
        body="Cycle: 318.4\n",  # no issue/project-item
        labels=[],
        changed_files=["backend/app/api.py"],
        diff="",
    )
    assert any("Issue:" in e and "ProjectItem:" in e for e in errors)


def test_validate_code_pr_nonexistent_cycle_fails():
    errors = validate(
        title="feat(999): pretend",
        body="Cycle: 99999\nIssue: #1\n",
        labels=[],
        changed_files=["backend/app/foo.py"],
        diff="",
    )
    assert any("cycle `99999` not found" in e for e in errors)


def test_validate_code_pr_completed_cycle_fails():
    """Find a cycle whose frontmatter actually says completed (any spelling)."""
    import re

    cycles_dir = REPO_ROOT / "docs" / "roadmap" / "cycles"
    completed_cycle: str | None = None
    for path in sorted(cycles_dir.glob("cycle*-*.md")):
        stem = path.stem
        assert stem.startswith("cycle")
        cycle_part = stem[len("cycle") :].split("-", 1)[0]
        if not re.fullmatch(r"\d+(?:\.\d+)*", cycle_part):
            continue
        # find_cycle_doc applies the "longest filename wins" tiebreaker
        # used by the validator itself — ask it directly so we're testing
        # the same cycle the gate would resolve.
        doc = find_cycle_doc(cycle_part)
        if doc is None or doc.path != path:
            continue
        status_norm = (doc.status or "").lower().strip()
        if status_norm in {"completed", "complete"}:
            completed_cycle = cycle_part
            break
    if not completed_cycle:
        pytest.skip("no completed cycle in repo to validate against")
    errors = validate(
        title="feat(test): test against completed cycle",
        body=f"Cycle: {completed_cycle}\nIssue: #1\n",
        labels=[],
        changed_files=["backend/app/foo.py"],
        diff="",
    )
    assert any(
        f"cycle `{completed_cycle}`" in e and "complete" in e.lower()
        for e in errors
    )


def test_validate_plan_pr_must_include_cited_cycle_doc_in_diff():
    """Plan PR includes a cycle doc but cites a different cycle → fail.

    The plan-PR classifier (post-#25) fires only when at least one
    cycle doc is in the diff. A PR that touches ``cycle999.md`` but
    cites ``Cycle: 318.4`` is still a plan PR (a real cycle doc is in
    the diff), but it cites the wrong cycle — validate() must surface
    that mismatch.
    """
    errors = validate(
        title="docs(roadmap): touch one cycle but cite another",
        body="Cycle: 318.4\n",
        labels=["plan-pr"],
        changed_files=[
            "docs/roadmap/cycles/cycle999-unrelated.md",
            "docs/architecture/something.md",
        ],
        diff="",
    )
    assert any(
        "plan PR cites" in e and "cycle318.4" in e for e in errors
    ), f"unexpected errors: {errors}"


def test_validate_plan_pr_happy_path():
    errors = validate(
        title="docs(roadmap): update cycle 318.4 plan",
        body="Cycle: 318.4\n",  # plan PRs don't need Issue:
        labels=[],
        changed_files=["docs/roadmap/cycles/cycle318.4-ci-fallback-and-auto-merge.md"],
        diff="",
    )
    assert errors == [], f"unexpected errors: {errors}"


def test_validate_non_cycle_pr_with_only_issue_passes():
    """CONTRIBUTING.md non-cycle PR path: drift/hotfix/dependabot uses
    `Issue: #<N>` instead of `Cycle:`. No Cycle required."""
    errors = validate(
        title="fix: backport a tiny dep",
        body="Closes #456\n",  # autoclose counts as Issue
        labels=[],
        changed_files=["package-lock.json"],
        diff="",
    )
    assert errors == [], f"unexpected errors: {errors}"


def test_validate_non_cycle_pr_with_explicit_issue_trailer_passes():
    errors = validate(
        title="chore: bump dep",
        body="Issue: #789\n",
        labels=[],
        changed_files=["package.json"],
        diff="",
    )
    assert errors == [], f"unexpected errors: {errors}"


def test_validate_non_cycle_pr_without_any_anchor_fails():
    """Non-cycle PR without Cycle: AND without Issue:/ProjectItem: must fail."""
    errors = validate(
        title="fix: tweak something",
        body="No trailers and no autoclose link.\n",
        labels=[],
        changed_files=["backend/app/api.py"],
        diff="",
    )
    assert any("missing trailer" in e or "Cycle: <N>" in e for e in errors)


@pytest.mark.parametrize(
    "label",
    ["dependencies", "automated", "autorelease: pending", "autorelease: tagged"],
)
def test_validate_bot_exempt_labels_bypass_trailer_checks(label):
    errors = validate(
        title="chore(deps): bump foo",
        body="",  # no trailers
        labels=[label],
        changed_files=["package.json"],
        diff="",
    )
    assert errors == [], f"label {label!r} did not exempt: {errors}"


def test_validate_bot_exempt_label_case_insensitive():
    errors = validate(
        title="chore: dependabot",
        body="",
        labels=["Dependencies"],  # mixed case
        changed_files=["package.json"],
        diff="",
    )
    assert errors == []


def test_is_bot_exempt_recognises_each_label():
    for label in ["dependencies", "automated", "autorelease: pending", "autorelease: tagged"]:
        assert is_bot_exempt([label])
    assert not is_bot_exempt(["bug", "frontend"])
    assert not is_bot_exempt([])


def test_validate_status_completion_in_implementing_pr_fails():
    """Same PR sets status: completed AND cites that cycle → fail."""
    diff = """\
+++ b/docs/roadmap/cycles/cycle318.4-ci-fallback-and-auto-merge.md
 ---
 cycle: 318.4
-status: in-progress
+status: completed
 ---
"""
    errors = validate(
        title="feat(318.4): implement and complete",
        body="Cycle: 318.4\nIssue: #1\n",
        labels=[],
        changed_files=[
            "docs/roadmap/cycles/cycle318.4-ci-fallback-and-auto-merge.md",
            "scripts/ci/validate_cycle_doc.py",
        ],
        diff=diff,
    )
    assert any("status: completed" in e and "318.4" in e for e in errors)


def test_validate_rejects_terminal_base_cycle_even_if_pr_doc_reopens_it():
    """Regression: PR checkout status must not hide a terminal base-ref cycle."""
    diff = """\
+++ b/docs/roadmap/cycles/cycle318.4-ci-fallback-and-auto-merge.md
 ---
 cycle: 318.4
-status: completed
+status: in-progress
 ---
"""
    errors = validate(
        title="feat(318.4): reopen stale cycle and ship more code",
        body="Cycle: 318.4\nIssue: #1\n",
        labels=[],
        changed_files=[
            "docs/roadmap/cycles/cycle318.4-ci-fallback-and-auto-merge.md",
            "scripts/ci/validate_cycle_doc.py",
        ],
        diff=diff,
        base_doc=CycleDoc(
            path=REPO_ROOT
            / "docs/roadmap/cycles/cycle318.4-ci-fallback-and-auto-merge.md",
            status="completed",
            superseded_by=None,
        ),
    )
    assert any("base ref" in e and "status: completed" in e for e in errors)


def test_cycle_docs_transitioned_to_terminal_treats_confirmed_404_as_new_file(
    tmp_path, monkeypatch
):
    """Missing base file is the only suppressed gh-api failure path."""
    path = "docs/roadmap/cycles/cycle999.md"
    head_path = tmp_path / path
    head_path.parent.mkdir(parents=True)
    head_path.write_text("---\ncycle: 999\nstatus: completed\n---\n", encoding="utf-8")
    monkeypatch.setattr(validator, "REPO_ROOT", tmp_path)

    def fake_run(*args, **kwargs):
        raise subprocess.CalledProcessError(
            1,
            args[0],
            stderr="gh: Not Found (HTTP 404)",
        )

    monkeypatch.setattr(validator.subprocess, "run", fake_run)

    assert (
        validator.cycle_docs_transitioned_to_terminal(
            repo="momentiq-ai/sage3c",
            base_ref="base-sha",
            gh_token=None,
            changed_files=[path],
        )
        == []
    )


def test_cycle_docs_transitioned_to_terminal_fails_closed_on_non_404_gh_exit_one(
    tmp_path, monkeypatch
):
    """gh exit code 1 is generic; auth/rate-limit/server failures must fail closed."""
    path = "docs/roadmap/cycles/cycle999.md"
    head_path = tmp_path / path
    head_path.parent.mkdir(parents=True)
    head_path.write_text("---\ncycle: 999\nstatus: completed\n---\n", encoding="utf-8")
    monkeypatch.setattr(validator, "REPO_ROOT", tmp_path)

    def fake_run(*args, **kwargs):
        raise subprocess.CalledProcessError(
            1,
            args[0],
            stderr="gh: API rate limit exceeded (HTTP 403)",
        )

    monkeypatch.setattr(validator.subprocess, "run", fake_run)

    with pytest.raises(validator.BaseCycleDocFetchError) as excinfo:
        validator.cycle_docs_transitioned_to_terminal(
            repo="momentiq-ai/sage3c",
            base_ref="base-sha",
            gh_token=None,
            changed_files=[path],
        )

    assert "exit 1" in str(excinfo.value)
    assert "rate limit" in str(excinfo.value)


# ---------------------------------------------------------------------------
# Multi-layout cycle-doc path support (docs/roadmap/cycles + docs/cycles)
# ---------------------------------------------------------------------------


def test_is_cycle_doc_path_accepts_legacy_layout():
    """Legacy ``docs/roadmap/cycles/`` is still recognized."""
    assert validator._is_cycle_doc_path("docs/roadmap/cycles/cycle1-foo.md") is True
    assert validator._is_cycle_doc_path("docs/roadmap/cycles/cycle331.5-bar.md") is True


def test_is_cycle_doc_path_accepts_new_layout():
    """New ``docs/cycles/`` layout (dark-factory-dashboard convention post-PR #105)
    is recognized without configuration."""
    assert validator._is_cycle_doc_path("docs/cycles/cycle1-foo.md") is True
    assert validator._is_cycle_doc_path("docs/cycles/cycle6-sota-chat.md") is True


def test_is_cycle_doc_path_rejects_non_cycle_files_in_either_layout():
    """README/notes/etc. inside either cycle dir are NOT cycle docs."""
    assert validator._is_cycle_doc_path("docs/roadmap/cycles/README.md") is False
    assert validator._is_cycle_doc_path("docs/cycles/README.md") is False
    assert validator._is_cycle_doc_path("docs/roadmap/notes.md") is False


def test_find_cycle_doc_searches_both_layouts(tmp_path, monkeypatch):
    """``find_cycle_doc`` searches every dir in CYCLE_DOC_DIRS on disk so
    consumers who've moved to ``docs/cycles/`` get a working lookup
    without configuration."""
    new_layout = tmp_path / "docs" / "cycles"
    new_layout.mkdir(parents=True)
    (new_layout / "cycle6-sota-chat.md").write_text(
        "---\ncycle: 6\nstatus: in-progress\n---\n", encoding="utf-8"
    )
    monkeypatch.setattr(validator, "REPO_ROOT", tmp_path)

    doc = validator.find_cycle_doc("6")
    assert doc is not None
    assert doc.path.name == "cycle6-sota-chat.md"
    assert doc.status == "in-progress"


def test_base_cycle_doc_falls_through_to_new_layout_on_legacy_404(
    tmp_path, monkeypatch
):
    """When ``docs/roadmap/cycles/`` 404s on the base ref (consumer moved
    to the new layout per dark-factory-dashboard#105), the validator MUST
    try ``docs/cycles/`` next instead of raising. This is the bug that
    blocked dark-factory-dashboard#136 (Cycle 6 plan PR) and every
    Cycle 6.x code PR after it from passing without an admin-override.

    Also exercises the "iterate ALL dirs" semantics — the listing loop
    intentionally does NOT break on the first successful response,
    because a consumer can have BOTH layouts present in a transitional
    state and the cycle may live in the second-listed dir even when the
    first listed dir exists with unrelated cycles.
    """
    listing_calls: list[list[str]] = []

    def fake_run(args, **kwargs):
        listing_calls.append(args)
        # First call (legacy dir) → 404; second call (new dir) → success.
        if "docs/roadmap/cycles" in args[2]:
            raise subprocess.CalledProcessError(
                1,
                args[0],
                stderr="gh: Not Found (HTTP 404)",
            )
        # docs/cycles → has the cycle 6 doc the PR cites.
        return SimpleNamespace(
            stdout=(
                '[{"name": "cycle6-sota-chat.md", "type": "file",'
                ' "path": "docs/cycles/cycle6-sota-chat.md"}]'
            ),
            stderr="",
        )

    monkeypatch.setattr(validator.subprocess, "run", fake_run)

    # The function ALSO fetches the file contents after the listing —
    # short-circuit by absorbing that inner BaseCycleDocFetchError. We're
    # only verifying that the listing loop fell through to the new layout
    # (i.e., a `docs/cycles/...` listing call DID happen after the
    # legacy 404).
    try:
        validator.base_cycle_doc(
            repo="momentiq-ai/dark-factory-dashboard",
            cycle_id="6",
            base_ref="base-sha",
            gh_token=None,
        )
    except validator.BaseCycleDocFetchError:
        pass

    legacy_calls = [a for a in listing_calls if "docs/roadmap/cycles" in a[2]]
    new_calls = [a for a in listing_calls if "docs/cycles" in a[2]]
    assert legacy_calls, "legacy dir MUST be probed first"
    assert new_calls, "fallthrough to docs/cycles/ MUST occur after legacy 404"


def test_base_cycle_doc_iterates_all_dirs_when_first_has_no_matching_cycle(
    tmp_path, monkeypatch
):
    """The listing loop MUST NOT break on the first successful response —
    a consumer with BOTH layouts present (e.g. sage3c-derived repo with
    legacy cycle331.x docs at ``docs/roadmap/cycles/`` PLUS a new cycle
    at ``docs/cycles/``) must have ALL dirs scanned so the cited cycle
    is found wherever it lives.

    Regresses the round-1 bug: prior code broke on the first listing
    that returned a 200 even if the listing held no matching cycle —
    a real failure mode for repos in transitional state.
    """
    listing_calls: list[list[str]] = []

    def fake_run(args, **kwargs):
        listing_calls.append(args)
        if "docs/roadmap/cycles" in args[2]:
            # Legacy dir EXISTS with unrelated cycles — the cited cycle
            # is NOT in this dir.
            return SimpleNamespace(
                stdout=(
                    '[{"name": "cycle331.1-foo.md", "type": "file",'
                    ' "path": "docs/roadmap/cycles/cycle331.1-foo.md"}]'
                ),
                stderr="",
            )
        # docs/cycles → has the cited cycle 6.
        return SimpleNamespace(
            stdout=(
                '[{"name": "cycle6-bar.md", "type": "file",'
                ' "path": "docs/cycles/cycle6-bar.md"}]'
            ),
            stderr="",
        )

    monkeypatch.setattr(validator.subprocess, "run", fake_run)
    try:
        validator.base_cycle_doc(
            repo="momentiq-ai/transitional",
            cycle_id="6",
            base_ref="base-sha",
            gh_token=None,
        )
    except validator.BaseCycleDocFetchError:
        # The file-content fetch after the listing may fail under the
        # stub; we're only asserting the listing-loop coverage here.
        pass

    legacy_listings = [a for a in listing_calls if "docs/roadmap/cycles" in a[2]]
    new_listings = [a for a in listing_calls if "docs/cycles" in a[2]]
    assert legacy_listings, "legacy dir must be probed"
    assert new_listings, (
        "must continue past a non-404 legacy response that lacks the cited cycle "
        "— prior break-on-first-success behavior would have stopped here"
    )


def test_base_cycle_doc_raises_when_all_layouts_404(tmp_path, monkeypatch):
    """If NEITHER cycle-doc dir exists on the base ref, the validator
    should raise with a clear error naming the candidates tried."""

    def fake_run(args, **kwargs):
        raise subprocess.CalledProcessError(
            1,
            args[0],
            stderr="gh: Not Found (HTTP 404)",
        )

    monkeypatch.setattr(validator.subprocess, "run", fake_run)

    with pytest.raises(validator.BaseCycleDocFetchError):
        validator.base_cycle_doc(
            repo="momentiq-ai/no-cycle-docs",
            cycle_id="6",
            base_ref="base-sha",
            gh_token=None,
        )


def test_is_gh_not_found_error_distinguishes_404_from_other_errors():
    """``_is_gh_not_found_error`` is what ``base_cycle_doc`` uses to
    decide "try next dir" vs "bubble up real error". Pin both branches.
    """
    err_404 = subprocess.CalledProcessError(
        1, ["gh"], stderr="gh: Not Found (HTTP 404)"
    )
    err_404_lower = subprocess.CalledProcessError(
        1, ["gh"], stderr="not found"
    )
    err_403 = subprocess.CalledProcessError(
        1, ["gh"], stderr="gh: API rate limit exceeded (HTTP 403)"
    )
    err_500 = subprocess.CalledProcessError(
        1, ["gh"], stderr="gh: server error (HTTP 500)"
    )

    assert validator._is_gh_not_found_error(err_404) is True
    assert validator._is_gh_not_found_error(err_404_lower) is True
    assert validator._is_gh_not_found_error(err_403) is False
    assert validator._is_gh_not_found_error(err_500) is False


# ---------------------------------------------------------------------------
# validate_objectives
# ---------------------------------------------------------------------------


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
    assert validate_objectives(tmp_path, trailers, [".darkfactory/objectives.yaml"]) == []


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
    errors = validate_objectives(tmp_path, trailers, [".darkfactory/objectives.yaml"])
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
    errors = validate_objectives(tmp_path, trailers, [".darkfactory/objectives.yaml"])
    assert any("verificationRoute" in e for e in errors)


def test_no_manifest_is_noop(tmp_path):
    trailers = parse_trailers("Cycle: 21\n")
    assert validate_objectives(tmp_path, trailers, [".darkfactory/objectives.yaml"]) == []


def test_objectives_skipped_when_manifest_not_in_diff(tmp_path):
    # Stale-manifest gate-break fix (#207): a committed manifest must NOT be
    # validated for a PR that doesn't author it (different trailers, manifest
    # untouched) — otherwise an old PR's objectives fail unrelated later PRs.
    _write_config(tmp_path, ["targeted-test"])
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: cycle21#ec1
            source: { kind: cycle, ref: "21" }
            text: "From an earlier PR."
            attestedBy: [{ kind: route, routeId: targeted-test }]
            enforced: false
    """)
    trailers = parse_trailers("Cycle: 22\n")  # different cycle, manifest untouched
    assert validate_objectives(tmp_path, trailers, ["src/unrelated.ts"]) == []
    # ...but when the PR DOES touch the manifest, the unlinked source is caught.
    errors = validate_objectives(tmp_path, trailers, [".darkfactory/objectives.yaml"])
    assert any("not linked" in e for e in errors)


def test_objectives_id_source_inconsistent(tmp_path):
    _write_config(tmp_path, ["targeted-test"])
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: cycle21#ec1
            source: { kind: cycle, ref: "22" }
            text: "Mismatched id vs source."
            attestedBy: [{ kind: route, routeId: targeted-test }]
            enforced: false
    """)
    trailers = parse_trailers("Cycle: 22\n")
    errors = validate_objectives(tmp_path, trailers, [".darkfactory/objectives.yaml"])
    assert any("inconsistent with source" in e for e in errors)


def test_objectives_enforced_must_be_bool(tmp_path):
    _write_config(tmp_path, ["targeted-test"])
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: cycle21#ec1
            source: { kind: cycle, ref: "21" }
            text: "x"
            attestedBy: [{ kind: route, routeId: targeted-test }]
            enforced: "nope"
    """)
    trailers = parse_trailers("Cycle: 21\n")
    errors = validate_objectives(tmp_path, trailers, [".darkfactory/objectives.yaml"])
    assert any("enforced" in e for e in errors)


def test_objectives_text_must_be_nonempty(tmp_path):
    _write_config(tmp_path, ["targeted-test"])
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: cycle21#ec1
            source: { kind: cycle, ref: "21" }
            text: ""
            attestedBy: [{ kind: route, routeId: targeted-test }]
            enforced: false
    """)
    trailers = parse_trailers("Cycle: 21\n")
    errors = validate_objectives(tmp_path, trailers, [".darkfactory/objectives.yaml"])
    assert any(".text" in e for e in errors)


def test_objectives_critic_binding_ok(tmp_path):
    _write_config(tmp_path, ["targeted-test"])
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: cycle21#ec1
            source: { kind: cycle, ref: "21" }
            text: "Critic-attested."
            attestedBy: [{ kind: critic, criticId: codex }]
            enforced: false
    """)
    trailers = parse_trailers("Cycle: 21\n")
    assert validate_objectives(tmp_path, trailers, [".darkfactory/objectives.yaml"]) == []


def test_objectives_critic_binding_missing_id(tmp_path):
    _write_config(tmp_path, ["targeted-test"])
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: cycle21#ec1
            source: { kind: cycle, ref: "21" }
            text: "x"
            attestedBy: [{ kind: critic }]
            enforced: false
    """)
    trailers = parse_trailers("Cycle: 21\n")
    errors = validate_objectives(tmp_path, trailers, [".darkfactory/objectives.yaml"])
    assert any("criticId" in e for e in errors)


def test_objectives_unknown_binding_kind(tmp_path):
    _write_config(tmp_path, ["targeted-test"])
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: cycle21#ec1
            source: { kind: cycle, ref: "21" }
            text: "x"
            attestedBy: [{ kind: vibes }]
            enforced: false
    """)
    trailers = parse_trailers("Cycle: 21\n")
    errors = validate_objectives(tmp_path, trailers, [".darkfactory/objectives.yaml"])
    assert any("route' | 'critic' | 'test'" in e for e in errors)


def test_objectives_bad_schema_version(tmp_path):
    _write_config(tmp_path, ["targeted-test"])
    _write_manifest(tmp_path, """
        schemaVersion: 2
        objectives: []
    """)
    trailers = parse_trailers("Cycle: 21\n")
    errors = validate_objectives(tmp_path, trailers, [".darkfactory/objectives.yaml"])
    assert any("schemaVersion" in e for e in errors)


def test_objectives_invalid_kind_no_misleading_not_linked(tmp_path):
    # An invalid source.kind surfaces ONLY the kind error — not an extra
    # "not linked" message the TS parser wouldn't emit.
    _write_config(tmp_path, ["targeted-test"])
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: cycle21#ec1
            source: { kind: nonsense, ref: "21" }
            text: "x"
            attestedBy: [{ kind: route, routeId: targeted-test }]
            enforced: false
    """)
    trailers = parse_trailers("Cycle: 21\n")
    errors = validate_objectives(tmp_path, trailers, [".darkfactory/objectives.yaml"])
    assert any("source.kind" in e for e in errors)
    assert not any("not linked" in e for e in errors)


def test_objectives_issue_bare_ref_linked(tmp_path):
    """Issue objective with bare ref ('1234') + 'Closes #1234' trailer → no error.

    This is the key regression the #-prefix normalization fix addresses: the TS
    parseObjective accepts ref: '1234' (bare), parse_trailers stores '#1234' from
    the autoclose keyword. Without normalization they never match.
    """
    _write_config(tmp_path, ["targeted-test"])
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: issue1234#ac1
            source: { kind: issue, ref: "1234" }
            text: "Bare ref links correctly."
            attestedBy:
              - { kind: route, routeId: targeted-test }
            enforced: false
    """)
    trailers = parse_trailers("Closes #1234\n")
    assert validate_objectives(tmp_path, trailers, [".darkfactory/objectives.yaml"]) == []


def test_objectives_issue_hash_ref_linked(tmp_path):
    """Issue objective with hash-prefixed ref ('#1234') + 'Issue: #1234' trailer → no error."""
    _write_config(tmp_path, ["targeted-test"])
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: issue1234#ac1
            source: { kind: issue, ref: "#1234" }
            text: "Hash-prefixed ref links correctly."
            attestedBy:
              - { kind: route, routeId: targeted-test }
            enforced: false
    """)
    trailers = parse_trailers("Issue: #1234\n")
    assert validate_objectives(tmp_path, trailers, [".darkfactory/objectives.yaml"]) == []


def test_objectives_issue_unmatched_ref(tmp_path):
    """Issue objective whose ref matches no trailer → 'not linked' error."""
    _write_config(tmp_path, ["targeted-test"])
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: issue9999#ac1
            source: { kind: issue, ref: "9999" }
            text: "Unlinked issue objective."
            attestedBy:
              - { kind: route, routeId: targeted-test }
            enforced: false
    """)
    trailers = parse_trailers("Closes #1234\n")
    errors = validate_objectives(tmp_path, trailers, [".darkfactory/objectives.yaml"])
    assert any("not linked" in e for e in errors)


def test_objectives_dotted_cycle_linked(tmp_path):
    """Dotted cycle objective (cycle318.4#ec1) links to 'Cycle: 318.4' trailer → no error.

    This is the regression the dotted-cycle support fixes: OBJECTIVE_ID_RE previously
    rejected ids containing a dot, and _declared_refs / validate_objectives previously
    did not normalize the cycle id through normalize_cycle_id.
    """
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: cycle318.4#ec1
            source: { kind: cycle, ref: "318.4" }
            text: "Dotted sub-cycle objective."
            attestedBy:
              - { kind: critic, criticId: codex }
            enforced: false
    """)
    trailers = parse_trailers("Cycle: 318.4\n")
    assert validate_objectives(tmp_path, trailers, [".darkfactory/objectives.yaml"]) == []


def test_objectives_malformed_manifest_top_level_list(tmp_path):
    """A top-level YAML list (not a mapping) returns an error and does NOT raise."""
    manifest = tmp_path / ".darkfactory" / "objectives.yaml"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text("- item1\n- item2\n")
    trailers = parse_trailers("Cycle: 21\n")
    errors = validate_objectives(tmp_path, trailers, [".darkfactory/objectives.yaml"])
    assert len(errors) == 1
    assert "top-level must be a mapping" in errors[0]


def test_objectives_non_dict_source(tmp_path):
    """An objective with a non-dict source field returns an error and does NOT raise."""
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: cycle21#ec1
            source: "not-a-dict"
            text: "Bad source."
            attestedBy:
              - { kind: critic, criticId: codex }
            enforced: false
    """)
    trailers = parse_trailers("Cycle: 21\n")
    errors = validate_objectives(tmp_path, trailers, [".darkfactory/objectives.yaml"])
    assert any("expected a mapping" in e for e in errors)


# ---------------------------------------------------------------------------
# source-criterion ratchet (2c)
# ---------------------------------------------------------------------------
import hashlib  # noqa: E402
import json as _json2  # noqa: E402

from validate_cycle_doc import canonicalize_criterion  # noqa: E402

CF = [".darkfactory/objectives.yaml"]


def _crit_hash(item_text):
    return hashlib.sha256(canonicalize_criterion(item_text).encode("utf-8")).hexdigest()


def _write_cycle_doc(repo_root, cycle_id, body):
    d = repo_root / "docs" / "roadmap" / "cycles"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"cycle{cycle_id}-test.md").write_text(textwrap.dedent(body))


def test_canonicalize_criterion_matches_fixture():
    # Cross-impl parity: Python canonicalize_criterion must agree with the TS
    # canonicalizeCriterion on the shared fixture (the TS side asserts the same file).
    cases = _json2.loads((Path(__file__).parent / "canonicalize-fixture.json").read_text())
    for c in cases:
        assert canonicalize_criterion(c["input"]) == c["expected"], c["input"]


def test_source_criterion_human_reviewed_ok(tmp_path):
    _write_config(tmp_path, ["targeted-test"])
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: cycle21#ec1
            source: { kind: cycle, ref: "21" }
            text: "x"
            attestedBy: [{ kind: route, routeId: targeted-test }]
            enforced: false
            sourceCriterion: { kind: human-reviewed, by: PJ }
    """)
    assert validate_objectives(tmp_path, parse_trailers("Cycle: 21\n"), CF) == []


def test_source_criterion_bad_locator(tmp_path):
    _write_config(tmp_path, ["targeted-test"])
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: cycle21#ec1
            source: { kind: cycle, ref: "21" }
            text: "x"
            attestedBy: [{ kind: route, routeId: targeted-test }]
            enforced: false
            sourceCriterion: { kind: text-hash, locator: "bad locator", sha256: "%s" }
    """ % ("a" * 64))
    errors = validate_objectives(tmp_path, parse_trailers("Cycle: 21\n"), CF)
    assert any("sourceCriterion.locator" in e for e in errors)


def test_source_criterion_text_hash_match(tmp_path, monkeypatch):
    monkeypatch.setattr(validator, "REPO_ROOT", tmp_path)
    _write_config(tmp_path, ["targeted-test"])
    _write_cycle_doc(tmp_path, "21", """
        ---
        status: in-progress
        ---
        ## Exit criteria

        - **EC1**: Route table populated.
        - **EC2**: Dashboard renders.
    """)
    good = _crit_hash("- **EC1**: Route table populated.")
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: cycle21#ec1
            source: { kind: cycle, ref: "21" }
            text: "Route table populated."
            attestedBy: [{ kind: route, routeId: targeted-test }]
            enforced: false
            sourceCriterion: { kind: text-hash, locator: "exit_criteria#ec1", sha256: "%s" }
    """ % good)
    assert validate_objectives(tmp_path, parse_trailers("Cycle: 21\n"), CF) == []


def test_source_criterion_text_hash_mismatch(tmp_path, monkeypatch):
    monkeypatch.setattr(validator, "REPO_ROOT", tmp_path)
    _write_config(tmp_path, ["targeted-test"])
    _write_cycle_doc(tmp_path, "21", """
        ---
        status: in-progress
        ---
        ## Exit criteria

        - **EC1**: Route table populated.
    """)
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: cycle21#ec1
            source: { kind: cycle, ref: "21" }
            text: "Route table populated."
            attestedBy: [{ kind: route, routeId: targeted-test }]
            enforced: false
            sourceCriterion: { kind: text-hash, locator: "exit_criteria#ec1", sha256: "%s" }
    """ % ("b" * 64))
    errors = validate_objectives(tmp_path, parse_trailers("Cycle: 21\n"), CF)
    assert any("does not match the source criterion" in e for e in errors)


def test_source_criterion_no_doc_is_non_blocking(tmp_path, monkeypatch):
    # Source not resolvable in-repo (no cycle doc) → NON-blocking note, no error.
    monkeypatch.setattr(validator, "REPO_ROOT", tmp_path)
    _write_config(tmp_path, ["targeted-test"])
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: cycle21#ec1
            source: { kind: cycle, ref: "21" }
            text: "x"
            attestedBy: [{ kind: route, routeId: targeted-test }]
            enforced: false
            sourceCriterion: { kind: text-hash, locator: "exit_criteria#ec1", sha256: "%s" }
    """ % ("a" * 64))
    errors = validate_objectives(tmp_path, parse_trailers("Cycle: 21\n"), CF)
    assert not any("sourceCriterion" in e for e in errors)


def test_source_criterion_not_found(tmp_path, monkeypatch):
    monkeypatch.setattr(validator, "REPO_ROOT", tmp_path)
    _write_config(tmp_path, ["targeted-test"])
    _write_cycle_doc(tmp_path, "21", """
        ---
        status: in-progress
        ---
        ## Exit criteria

        - **EC1**: Route table populated.
    """)
    _write_manifest(tmp_path, """
        schemaVersion: 1
        objectives:
          - id: cycle21#ec9
            source: { kind: cycle, ref: "21" }
            text: "x"
            attestedBy: [{ kind: route, routeId: targeted-test }]
            enforced: false
            sourceCriterion: { kind: text-hash, locator: "exit_criteria#ec9", sha256: "%s" }
    """ % ("a" * 64))
    errors = validate_objectives(tmp_path, parse_trailers("Cycle: 21\n"), CF)
    assert any("not found in the cycle doc" in e for e in errors)
