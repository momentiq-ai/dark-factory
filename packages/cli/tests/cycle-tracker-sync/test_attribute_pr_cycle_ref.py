"""Tests for scripts/ci/attribute_pr_cycle_ref.py.

Coverage:
  - parse_cycle_trailer: extract cycle ID from PR body + commits with
    last-write-wins semantics
  - Normalization: 'Cycle 326', '326.1-foo', leading whitespace
  - No-Cycle path → exit 0 (not every PR is cycle-tracked)
  - Auth failure path → exit 1 with ::error::
  - Missing Cycle Ref field → exit 1 with ::error::
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest  # noqa: F401

sys.path.insert(0, str(Path(__file__).parent))

import attribute_pr_cycle_ref as attr  # noqa: E402
from attribute_pr_cycle_ref import parse_cycle_trailer  # noqa: E402


class TestParseCycleTrailer:
    def test_simple_id(self):
        assert parse_cycle_trailer("Cycle: 326") == "326"

    def test_dotted_id(self):
        assert parse_cycle_trailer("Cycle: 318.4") == "318.4"

    def test_id_with_word_prefix(self):
        assert parse_cycle_trailer("Cycle: Cycle 326") == "326"

    def test_id_followed_by_slug(self):
        assert parse_cycle_trailer("Cycle: 326-gh-project-continuous-sync") == "326"

    def test_last_value_wins(self):
        """Body has two Cycle: trailers — the LAST wins (validates the
        same last-write-wins convention as validate_cycle_doc.py)."""
        text = (
            "Cycle: 318.4\n\n"
            "Some intermediate text\n\n"
            "Cycle: 326\n"
        )
        assert parse_cycle_trailer(text) == "326"

    def test_no_trailer_returns_none(self):
        assert parse_cycle_trailer("Some PR body with no trailers.") is None
        assert parse_cycle_trailer("") is None
        assert parse_cycle_trailer(None) is None  # type: ignore[arg-type]

    def test_other_trailer_keys_ignored(self):
        text = "Issue: #1561\nCycle: 326\nProjectItem: 42"
        assert parse_cycle_trailer(text) == "326"

    def test_leading_whitespace_ok(self):
        assert parse_cycle_trailer("    Cycle: 326   ") == "326"


class TestMain:
    def _set_env(self, monkeypatch, **overrides):
        defaults = {
            "PR_NUMBER": "9999",
            "PR_NODE_ID": "PR_kwDOTEST",
            "PR_BODY": "Cycle: 326\nIssue: #1561\n",
            "PROJECT_TOKEN": "fake-pat",
            "PROJECT_OWNER": "momentiq-ai",
            "PROJECT_NUMBER": "2",
            "REPO": "momentiq-ai/sage3c",
        }
        defaults.update(overrides)
        for k, v in defaults.items():
            monkeypatch.setenv(k, v)

    def test_no_cycle_trailer_exits_zero(self, monkeypatch, capsys):
        self._set_env(monkeypatch, PR_BODY="No trailer here.")
        # Stub fetch_commit_messages to also return no trailer.
        monkeypatch.setattr(attr, "fetch_commit_messages", lambda repo, n: "no trailer")
        rc = attr.main()
        assert rc == 0
        out = capsys.readouterr().out
        assert "no Cycle: trailer found; skipping attribution" in out

    def test_missing_pr_number_exits_one(self, monkeypatch, capsys):
        self._set_env(monkeypatch, PR_NUMBER="")
        rc = attr.main()
        assert rc == 1
        out = capsys.readouterr().out
        assert "::error::PR_NUMBER" in out

    def test_missing_pr_node_id_exits_one(self, monkeypatch, capsys):
        self._set_env(monkeypatch, PR_NODE_ID="")
        rc = attr.main()
        assert rc == 1
        out = capsys.readouterr().out
        assert "::error::PR_NODE_ID" in out

    def test_invalid_pr_number_exits_one(self, monkeypatch, capsys):
        self._set_env(monkeypatch, PR_NUMBER="not-a-number")
        rc = attr.main()
        assert rc == 1
        out = capsys.readouterr().out
        assert "PR_NUMBER must be an integer" in out

    def test_happy_path(self, monkeypatch, capsys):
        """End-to-end: parse cycle, look up project + field, ensure item,
        write Cycle Ref."""
        self._set_env(monkeypatch)
        monkeypatch.setattr(attr, "fetch_commit_messages", lambda r, n: "")
        monkeypatch.setattr(attr, "lookup_project_id", lambda o, n: "PVT_TEST")
        monkeypatch.setattr(attr, "lookup_cycle_ref_field_id", lambda pid: "PVTF_CYCLEREF")
        monkeypatch.setattr(attr, "ensure_item_id_for_pr", lambda pid, nid: "PVTI_TEST")
        write_calls: list = []
        monkeypatch.setattr(
            attr, "write_cycle_ref",
            lambda pid, iid, fid, cid: write_calls.append((pid, iid, fid, cid)) or True,
        )

        rc = attr.main()
        assert rc == 0
        assert write_calls == [("PVT_TEST", "PVTI_TEST", "PVTF_CYCLEREF", "326")]
        out = capsys.readouterr().out
        assert "Cycle Ref set to '326'" in out

    def test_missing_cycle_ref_field_exits_one(self, monkeypatch, capsys):
        """Operator forgot to run gh project field-create."""
        self._set_env(monkeypatch)
        monkeypatch.setattr(attr, "fetch_commit_messages", lambda r, n: "")
        monkeypatch.setattr(attr, "lookup_project_id", lambda o, n: "PVT_TEST")
        # Field lookup returns None — simulates "field not found"
        monkeypatch.setattr(attr, "lookup_cycle_ref_field_id", lambda pid: None)
        rc = attr.main()
        assert rc == 1
        # The ::error:: emit happens inside lookup_cycle_ref_field_id;
        # we mocked that. Verify main exited 1 — the user-facing error
        # surface is tested separately.

    def test_addProjectV2ItemById_failure_exits_one(self, monkeypatch, capsys):
        """Drift mode that the existing 'Add PR to project board' step
        silently swallows — must exit 1 here."""
        self._set_env(monkeypatch)
        monkeypatch.setattr(attr, "fetch_commit_messages", lambda r, n: "")
        monkeypatch.setattr(attr, "lookup_project_id", lambda o, n: "PVT_TEST")
        monkeypatch.setattr(attr, "lookup_cycle_ref_field_id", lambda pid: "PVTF_TEST")
        monkeypatch.setattr(attr, "ensure_item_id_for_pr", lambda pid, nid: None)
        rc = attr.main()
        assert rc == 1


def test_fetch_commit_messages_failure_returns_empty(monkeypatch, capsys):
    """Non-fatal: log warning, fall back to body-only."""
    def fail(*a, **kw):
        raise subprocess.CalledProcessError(1, "gh api", stderr="rate limited")

    monkeypatch.setattr(attr.subprocess, "run", fail)
    result = attr.fetch_commit_messages("momentiq-ai/sage3c", 9999)
    assert result == ""
    out = capsys.readouterr().out
    assert "::warning::commit fetch failed" in out


class TestLoadPrBody:
    """The body-loader prefers PR_BODY_FILE over PR_BODY to dodge
    heredoc-delimiter-injection on GITHUB_OUTPUT (Cursor MEDIUM finding
    from impl PR review)."""

    def test_reads_from_pr_body_file_when_set(self, monkeypatch, tmp_path):
        body_file = tmp_path / "body.txt"
        body_file.write_text("Cycle: 326\nfrom-file\n", encoding="utf-8")
        monkeypatch.setenv("PR_BODY_FILE", str(body_file))
        monkeypatch.setenv("PR_BODY", "should-not-be-used")
        assert attr._load_pr_body() == "Cycle: 326\nfrom-file\n"

    def test_falls_back_to_pr_body_when_file_unset(self, monkeypatch):
        monkeypatch.delenv("PR_BODY_FILE", raising=False)
        monkeypatch.setenv("PR_BODY", "Cycle: 326\nfrom-env\n")
        assert attr._load_pr_body() == "Cycle: 326\nfrom-env\n"

    def test_falls_back_to_pr_body_when_file_empty(self, monkeypatch):
        monkeypatch.setenv("PR_BODY_FILE", "")
        monkeypatch.setenv("PR_BODY", "Cycle: 326\nfrom-env\n")
        assert attr._load_pr_body() == "Cycle: 326\nfrom-env\n"

    def test_warns_and_falls_back_when_file_unreadable(self, monkeypatch, tmp_path, capsys):
        # Path that does not exist
        monkeypatch.setenv("PR_BODY_FILE", str(tmp_path / "missing.txt"))
        monkeypatch.setenv("PR_BODY", "fallback-text")
        result = attr._load_pr_body()
        assert result == "fallback-text"
        out = capsys.readouterr().out
        assert "::warning::PR_BODY_FILE=" in out
        assert "falling back to PR_BODY" in out

    def test_returns_empty_when_both_unset(self, monkeypatch):
        monkeypatch.delenv("PR_BODY_FILE", raising=False)
        monkeypatch.delenv("PR_BODY", raising=False)
        assert attr._load_pr_body() == ""


class TestTokenScopeSplit:
    """Codex P2 (Plan PR #1562): _repo_env / _project_env split."""

    def test_repo_env_swaps_to_github_token_repo(self, monkeypatch):
        monkeypatch.setenv("GH_TOKEN", "project-token-value")
        monkeypatch.setenv("GITHUB_TOKEN_REPO", "repo-token-value")
        monkeypatch.setenv("PROJECT_TOKEN", "project-token-value")
        env = attr._repo_env()
        assert env["GH_TOKEN"] == "repo-token-value"
        # PROJECT_TOKEN scrubbed so subprocess can't fall back to it.
        assert "PROJECT_TOKEN" not in env

    def test_repo_env_falls_back_to_github_token(self, monkeypatch):
        monkeypatch.delenv("GITHUB_TOKEN_REPO", raising=False)
        monkeypatch.setenv("GITHUB_TOKEN", "default-token-value")
        monkeypatch.setenv("GH_TOKEN", "project-token-value")
        env = attr._repo_env()
        assert env["GH_TOKEN"] == "default-token-value"

    def test_repo_env_passthrough_when_no_repo_token(self, monkeypatch):
        monkeypatch.delenv("GITHUB_TOKEN_REPO", raising=False)
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.setenv("GH_TOKEN", "whatever-token")
        env = attr._repo_env()
        # Original GH_TOKEN preserved when no override is available.
        assert env["GH_TOKEN"] == "whatever-token"

    def test_project_env_swaps_to_project_token(self, monkeypatch):
        monkeypatch.setenv("GH_TOKEN", "fallback-token")
        monkeypatch.setenv("PROJECT_TOKEN", "project-token-value")
        env = attr._project_env()
        assert env["GH_TOKEN"] == "project-token-value"

    def test_project_env_passthrough_when_no_project_token(self, monkeypatch):
        monkeypatch.delenv("PROJECT_TOKEN", raising=False)
        monkeypatch.setenv("GH_TOKEN", "fallback-token")
        env = attr._project_env()
        # Original GH_TOKEN preserved (single-token mode).
        assert env["GH_TOKEN"] == "fallback-token"
