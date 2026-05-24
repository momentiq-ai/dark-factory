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


def test_validate_plan_pr_must_include_cycle_doc_in_diff():
    """Plan PR cites cycle 318.4 but doesn't modify its doc → fail."""
    errors = validate(
        title="docs(roadmap): unrelated docs change",
        body="Cycle: 318.4\n",
        labels=["plan-pr"],
        changed_files=["docs/architecture/something.md"],
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
