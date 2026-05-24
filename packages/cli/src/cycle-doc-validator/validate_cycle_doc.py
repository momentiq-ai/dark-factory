#!/usr/bin/env python3
"""Cycle 318.4 Component 2 — cycle-doc CI gate.

Enforces AI-Native Manifesto §10 (Spec-Driven Traceability) per the
trailer policy documented in ``CONTRIBUTING.md``: every PR has some
anchor in the project's tracking surface, with two paths:

  * **Cycle-tracked product code** — ``Cycle: <N>`` references a cycle
    doc in ``docs/roadmap/cycles/`` (the cycle must exist and not be
    in a terminal status); ``Issue:`` OR ``ProjectItem:`` is also
    required as a secondary anchor.
  * **Non-cycle PRs** (drift fixes, dependabot bumps, doc tweaks,
    hotfixes) — no ``Cycle:`` required; ``Issue:`` OR ``ProjectItem:``
    alone is sufficient.
  * **Bot/automation PRs** carrying an allowlisted label
    (``dependencies`` / ``automated`` / ``autorelease: pending`` /
    ``autorelease: tagged``) bypass trailer enforcement entirely.

Without this gate, the existing PR-body substring check in
``.github/workflows/quality-gate.yml`` only catches that the strings
"cycle doc", "definition of done", etc. appear — it does not parse
trailers, does not verify the referenced cycle exists, and does not
distinguish plan PRs from code PRs.

Inputs (all environment variables; the workflow sets them):

  PR_NUMBER     — PR number being validated.
  PR_TITLE      — full PR title.
  PR_BODY       — full PR body (the description shown on GitHub).
  PR_LABELS     — JSON array of label objects, ``[{"name":"plan-pr"},...]``.
  REPO          — ``owner/name``.
  GH_TOKEN      — token with ``repo:read`` for the changed-files lookup.

Outputs:

  exit 0 on success; exit 1 with an actionable stderr message on failure.

The check matrix (per Component 2 of cycle318.4-ci-fallback-and-auto-merge.md,
aligned with CONTRIBUTING.md "Trailers" section):

  1. **Type detection.** Plan PR if title starts with ``docs(roadmap):``
     or ``docs(<cycle>):``, OR PR has label ``plan-pr``, AND every
     changed path is under ``docs/`` (or is the repo-root ``AGENTS.md``
     / ``CLAUDE.md``). The "docs only" check is broader than just
     cycle-doc paths so a plan PR can include supporting ADR / engineering
     docs in the same change without being misclassified as a code PR.
     Otherwise code PR.

  2. **Bot/automation exemption.** PRs with any of the labels
     ``dependencies`` / ``automated`` / ``autorelease: pending`` /
     ``autorelease: tagged`` short-circuit to PASS without trailer
     checks. Matches CONTRIBUTING.md "Bot / automation PRs are exempted
     by label allowlist".

  3. **Trailer parsing.** Read PR body AND every commit message in the
     PR; extract ``Cycle:``, ``Issue:``, ``ProjectItem:`` trailer values
     per ``git-interpret-trailers`` semantics. Commit messages are
     fetched via ``gh api repos/<repo>/pulls/<n>/commits`` and
     concatenated to the body before parsing. GitHub auto-close keywords
     (``Closes #N``, ``Fixes #N``, ``Resolves #N``) count as an
     ``Issue:`` trailer for the purpose of this gate.

  4. **Code PR with Cycle: (product code).** When ``Cycle: <N>`` is
     present, the cycle must resolve to
     ``docs/roadmap/cycles/cycle<N>*.md`` and status must not be
     terminal (completed/complete/superseded/abandoned/absorbed). An
     ``Issue:`` OR ``ProjectItem:`` MUST also be present (one is
     sufficient).

  5. **Code PR without Cycle: (drift / hotfix / non-cycle).** When
     no ``Cycle:`` is present, ``Issue:`` OR ``ProjectItem:`` MUST be
     present. This is the non-cycle-PR path documented in
     CONTRIBUTING.md (drift fixes, dependabot bumps, doc tweaks,
     hotfixes).

  6. **Plan PR rules.** ``Cycle: <N>`` MUST be present AND the diff
     must include ``docs/roadmap/cycles/cycle<N>*.md`` (i.e., the PR
     is creating or updating that cycle's plan).

  7. **Status transitions.** If the same diff sets ``status: completed``
     on a cycle's frontmatter, fail with a clear message — completion
     belongs in a separate doc-update PR after the implementing code
     PR has merged.

Failure messages name the file and the missing/conflicting field so
operators can fix without reading this script.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

def _resolve_repo_root() -> Path:
    """Resolve the consumer repo root.

    Phase C extraction (cycle 331.1): the same script ships inside
    ``@momentiq/dark-factory-cli`` and is invoked from arbitrary cwds
    in consumer repos. Resolution order:

      1. ``DF_REPO_ROOT`` env var — explicit override (the TS CLI wrapper
         sets this when spawning).
      2. ``git rev-parse --show-toplevel`` from the current cwd — the
         standard "find the consumer repo" path for any in-repo invocation.
      3. ``Path(__file__).resolve().parents[2]`` — legacy fallback that
         matched sage3c's ``scripts/ci/`` layout. Kept so the original
         pytest contract still works when the script is invoked in-tree.
    """
    override = os.environ.get("DF_REPO_ROOT")
    if override:
        return Path(override).resolve()
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
        )
        return Path(result.stdout.strip()).resolve()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return Path(__file__).resolve().parents[2]


REPO_ROOT = _resolve_repo_root()
CYCLES_DIR = REPO_ROOT / "docs" / "roadmap" / "cycles"
CYCLE_DOC_GLOB = "docs/roadmap/cycles/cycle*.md"

# Trailers we recognize. ``git-interpret-trailers`` defines a trailer as
# ``Token: Value`` on its own line in the trailer block; we accept the
# same shape anywhere in the body text, since GitHub PR bodies don't have
# a strict trailer block.
TRAILER_RE = re.compile(r"^\s*(?P<key>[A-Za-z][A-Za-z0-9-]*):\s*(?P<value>.+?)\s*$", re.MULTILINE)

# GitHub auto-close keywords — treat as equivalent to ``Issue:`` trailers.
# Matches "Closes #123", "fixes momentiq-ai/sage3c#42", "Resolves #5", etc.
GH_AUTOCLOSE_RE = re.compile(
    r"\b(?P<verb>close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+"
    r"(?:(?P<repo>[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+))?#(?P<num>\d+)\b",
    re.IGNORECASE,
)

# Plan-PR title patterns: ``docs(roadmap): ...`` or ``docs(<cycle>): ...``
# where <cycle> looks like a cycle number (118, 318.4, etc.).
PLAN_TITLE_RE = re.compile(
    r"^docs\((?:roadmap|\d+(?:\.\d+)*)\):",
)

# Bot/automation label allowlist per CONTRIBUTING.md "Trailers" section.
# PRs carrying any of these labels skip the trailer requirement.
BOT_EXEMPT_LABELS = frozenset(
    {
        "dependencies",
        "automated",
        "autorelease: pending",
        "autorelease: tagged",
    }
)


@dataclass
class Trailers:
    """Parsed trailer set with normalized presence flags."""

    cycle: str | None = None
    issue: str | None = None
    project_item: str | None = None
    raw: dict[str, list[str]] = field(default_factory=dict)


@dataclass
class CycleDoc:
    path: Path
    status: str | None
    superseded_by: str | None


def parse_trailers(text: str) -> Trailers:
    """Extract recognized trailers from a body of text.

    Multiple values per key are preserved in ``raw`` so a downstream
    consumer can debug accidentally-doubled trailers. The convenience
    fields ``cycle`` / ``issue`` / ``project_item`` carry the LAST seen
    value of each (the trailer-block tail is the canonical position).
    """
    out = Trailers()
    for match in TRAILER_RE.finditer(text):
        key = match.group("key").lower()
        value = match.group("value").strip()
        out.raw.setdefault(key, []).append(value)
        if key == "cycle":
            out.cycle = value
        elif key == "issue":
            out.issue = value
        elif key == "projectitem":
            out.project_item = value

    if out.issue is None:
        # GitHub auto-close keywords substitute for an explicit Issue: trailer.
        # We only need ONE match — the gate doesn't care which issue is linked.
        autoclose = GH_AUTOCLOSE_RE.search(text)
        if autoclose:
            out.issue = f"#{autoclose.group('num')}"
            out.raw.setdefault("_autoclose", []).append(autoclose.group(0))
    return out


def normalize_cycle_id(raw: str) -> str | None:
    """Pull the cycle id out of a trailer value.

    Accepts ``318.4``, ``318``, ``Cycle 318.4``, ``318.4-foo``. Rejects
    obviously malformed input. The id is a dotted-decimal sequence of
    1-4 segments (``318``, ``318.4``, ``313.1.e`` would NOT match — we
    accept only digits + dots for the gate's normalized form, which is
    what ``sync_cycle_trackers.py`` already standardizes on).
    """
    if not raw:
        return None
    # Strip any leading word like "Cycle " or surrounding markdown.
    candidate = raw.strip()
    # Take just the leading cycle-id token; drop any trailing text after
    # the first whitespace or punctuation that isn't ``.`` or a digit.
    m = re.match(r"(\d+(?:\.\d+)*)", candidate)
    if not m:
        return None
    return m.group(1)


def find_cycle_doc(cycle_id: str) -> CycleDoc | None:
    """Locate ``docs/roadmap/cycles/cycle<id>*.md`` and read its status."""
    matches = sorted(CYCLES_DIR.glob(f"cycle{cycle_id}-*.md")) + sorted(
        CYCLES_DIR.glob(f"cycle{cycle_id}.md")
    )
    if not matches:
        return None
    # If multiple matches exist (legacy ``cycle318.md`` + new ``cycle318-foo.md``),
    # prefer the one with the longer name (more descriptive slug).
    path = max(matches, key=lambda p: len(p.name))
    status, superseded_by = read_cycle_frontmatter(path)
    return CycleDoc(path=path, status=status, superseded_by=superseded_by)


def read_cycle_frontmatter(path: Path) -> tuple[str | None, str | None]:
    """Read the ``status:`` and ``superseded_by:`` fields from frontmatter.

    Frontmatter parsing is deliberately simple — we don't pull PyYAML
    for this since the validator runs in CI on every PR and we want a
    fast, dependency-light boot. Frontmatter is the first ``---`` block
    at the top of the file; we look for ``status:`` and
    ``superseded_by:`` lines until the closing ``---``.
    """
    status: str | None = None
    superseded_by: str | None = None
    try:
        with path.open(encoding="utf-8") as fh:
            inside = False
            for line in fh:
                if line.strip() == "---":
                    if not inside:
                        inside = True
                        continue
                    break  # closing fence
                if not inside:
                    continue
                stripped = line.strip()
                if stripped.startswith("status:"):
                    status = stripped[len("status:") :].strip().strip("\"'")
                elif stripped.startswith("superseded_by:"):
                    superseded_by = stripped[len("superseded_by:") :].strip().strip("\"'")
    except OSError:
        return None, None
    return status, superseded_by


def read_cycle_frontmatter_from_text(text: str) -> tuple[str | None, str | None]:
    """Read the ``status:`` and ``superseded_by:`` fields from frontmatter text."""
    status: str | None = None
    superseded_by: str | None = None
    inside = False
    for line in text.splitlines():
        if line.strip() == "---":
            if not inside:
                inside = True
                continue
            break
        if not inside:
            continue
        stripped = line.strip()
        if stripped.startswith("status:"):
            status = stripped[len("status:") :].strip().strip("\"'")
        elif stripped.startswith("superseded_by:"):
            superseded_by = stripped[len("superseded_by:") :].strip().strip("\"'")
    return status, superseded_by


class BaseCycleDocFetchError(RuntimeError):
    """Raised when the base-ref cycle document cannot be read."""


def _is_gh_not_found_error(exc: subprocess.CalledProcessError) -> bool:
    """Return True only for confirmed missing-content responses from gh."""

    output = f"{exc.stderr or ''}\n{exc.stdout or ''}".lower()
    return "404" in output or "not found" in output


def base_cycle_doc(
    repo: str,
    cycle_id: str,
    base_ref: str,
    gh_token: str | None,
) -> CycleDoc | None:
    """Read the cited cycle doc from the protected base ref.

    CI checks out the PR head, so a PR can edit the cited doc before
    this validator reads it from disk. Use the GitHub contents API
    against the immutable base SHA to catch cycles that were already
    terminal before the PR.
    """
    env = os.environ.copy()
    if gh_token:
        env["GH_TOKEN"] = gh_token

    try:
        listing_result = subprocess.run(
            [
                "gh",
                "api",
                f"repos/{repo}/contents/docs/roadmap/cycles?ref={base_ref}",
            ],
            check=True,
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
        )
    except FileNotFoundError as exc:
        raise BaseCycleDocFetchError(
            "gh CLI not on PATH; cannot read cycle docs from base ref."
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise BaseCycleDocFetchError(
            f"gh api repos/{repo}/contents/docs/roadmap/cycles failed "
            f"(exit {exc.returncode}): {exc.stderr.strip()}"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise BaseCycleDocFetchError(
            f"gh api repos/{repo}/contents/docs/roadmap/cycles timed out after {exc.timeout}s"
        ) from exc

    try:
        entries = json.loads(listing_result.stdout)
    except json.JSONDecodeError as exc:
        raise BaseCycleDocFetchError(
            "GitHub contents API returned malformed JSON for cycle docs listing."
        ) from exc

    pattern = re.compile(rf"^cycle{re.escape(cycle_id)}(?:-.+)?\.md$")
    candidates = [
        entry
        for entry in entries
        if isinstance(entry, dict)
        and entry.get("type") == "file"
        and isinstance(entry.get("name"), str)
        and pattern.match(entry["name"])
    ]
    if not candidates:
        return None

    chosen = max(candidates, key=lambda entry: len(entry["name"]))
    path = chosen.get("path")
    if not isinstance(path, str) or not path:
        raise BaseCycleDocFetchError(
            f"GitHub contents API returned a cycle doc entry without a path for cycle {cycle_id}."
        )

    try:
        content_result = subprocess.run(
            [
                "gh",
                "api",
                f"repos/{repo}/contents/{path}?ref={base_ref}",
                "--jq",
                ".content",
            ],
            check=True,
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
        )
    except subprocess.CalledProcessError as exc:
        raise BaseCycleDocFetchError(
            f"gh api repos/{repo}/contents/{path} failed "
            f"(exit {exc.returncode}): {exc.stderr.strip()}"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise BaseCycleDocFetchError(
            f"gh api repos/{repo}/contents/{path} timed out after {exc.timeout}s"
        ) from exc

    try:
        decoded = base64.b64decode(content_result.stdout).decode("utf-8")
    except (UnicodeDecodeError, ValueError) as exc:
        raise BaseCycleDocFetchError(
            f"Could not decode base-ref cycle doc `{path}` from GitHub contents API."
        ) from exc

    status, superseded_by = read_cycle_frontmatter_from_text(decoded)
    return CycleDoc(path=REPO_ROOT / path, status=status, superseded_by=superseded_by)


class ChangedFilesFetchError(RuntimeError):
    """Raised when the PR-files API is unreachable.

    Surfacing the failure (rather than returning an empty list) lets
    the caller fail-closed: empty changed-files would push every PR
    into the code-PR rule set (Issue/ProjectItem required), so a
    transient gh outage could falsely block a legitimate plan PR.
    """


def pr_changed_files(repo: str, pr_number: int, gh_token: str | None) -> list[str]:
    """Fetch the PR's changed file list via the GitHub API.

    Raises :class:`ChangedFilesFetchError` on any transport failure so
    the caller can distinguish "no files changed" (legitimate) from
    "could not enumerate files" (the gate must fail-closed rather than
    silently mis-classify the PR as code-PR).
    """
    env = os.environ.copy()
    if gh_token:
        env["GH_TOKEN"] = gh_token
    args = [
        "gh",
        "api",
        "--paginate",
        f"repos/{repo}/pulls/{pr_number}/files",
        "--jq",
        ".[].filename",
    ]
    try:
        result = subprocess.run(
            args,
            check=True,
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
        )
    except FileNotFoundError as exc:
        raise ChangedFilesFetchError(
            "gh CLI not on PATH; cannot enumerate PR changed files."
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise ChangedFilesFetchError(
            f"gh api repos/{repo}/pulls/{pr_number}/files failed "
            f"(exit {exc.returncode}): {exc.stderr.strip()}"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise ChangedFilesFetchError(
            f"gh api repos/{repo}/pulls/{pr_number}/files timed out after {exc.timeout}s"
        ) from exc
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


class DiffFetchError(RuntimeError):
    """Raised when the PR-diff API is unreachable.

    The status-completion guard reads the diff to detect PRs that flip
    a cited cycle's frontmatter to ``status: completed``. Without the
    diff, the guard fails open — exactly the failure mode the gate
    exists to prevent. Surfacing the error lets ``main()`` fail-closed.
    """


def pr_diff_patches(repo: str, pr_number: int, gh_token: str | None) -> str:
    """Fetch the full unified diff of the PR.

    Raises :class:`DiffFetchError` on any transport failure so the
    caller can fail-closed. A silently-empty return value would mean
    the status-completion guard never fires — that's exactly the bypass
    surface this cycle is meant to harden, so any inability to read the
    diff must surface.
    """
    env = os.environ.copy()
    if gh_token:
        env["GH_TOKEN"] = gh_token
    args = [
        "gh",
        "pr",
        "diff",
        str(pr_number),
        "--repo",
        repo,
    ]
    try:
        result = subprocess.run(
            args,
            check=True,
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
        )
    except FileNotFoundError as exc:
        raise DiffFetchError(
            "gh CLI not on PATH; cannot fetch PR diff for status-transition check."
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise DiffFetchError(
            f"gh pr diff {pr_number} --repo {repo} failed (exit {exc.returncode}): "
            f"{exc.stderr.strip()}"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise DiffFetchError(
            f"gh pr diff {pr_number} --repo {repo} timed out after {exc.timeout}s"
        ) from exc
    return result.stdout


class CommitMessagesFetchError(RuntimeError):
    """Raised when the PR-commits API is unreachable.

    Trailers on the last commit (the documented Sage workflow) live
    here, not in the PR body. Silently degrading to "body-only" hides
    half of the trailer surface and can produce false-red gate failures
    for PRs that follow the documented commit-trailer convention.
    Fail-closed and let the operator retry once gh is reachable.
    """


def pr_commit_messages(repo: str, pr_number: int, gh_token: str | None) -> list[str]:
    """Fetch the commit messages for every commit in the PR.

    Returns a list of commit messages in chronological order
    (oldest → newest). Each message is preserved intact (including any
    blank lines inside the body); the list-of-strings shape avoids the
    delimiter-ambiguity that a single ``"\n\n"``-joined string would
    have when commit bodies contain blank paragraphs of their own.

    Trailers placed on the last commit (the documented Sage workflow
    per CLAUDE.md "Commit Messages" section) are visible to the gate
    alongside trailers in the PR body via :func:`build_trailer_input`.

    Raises :class:`CommitMessagesFetchError` on transport failure so
    the caller can fail-closed — mirroring the discipline applied to
    :func:`pr_changed_files` and :func:`pr_diff_patches`. Silent
    "body-only" degradation would mean a transient gh outage produces
    false-red gate failures for PRs that follow the documented
    last-commit-trailer convention.
    """
    env = os.environ.copy()
    if gh_token:
        env["GH_TOKEN"] = gh_token
    # Fetch structured JSON rather than --jq-flattening to a list of
    # strings; the latter collapses commit messages whose body spans
    # multiple lines and breaks trailer-block detection per git's own
    # parsing semantics. We parse the JSON ourselves.
    args = [
        "gh",
        "api",
        "--paginate",
        f"repos/{repo}/pulls/{pr_number}/commits",
    ]
    try:
        result = subprocess.run(
            args,
            check=True,
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
        )
    except FileNotFoundError as exc:
        raise CommitMessagesFetchError(
            "gh CLI not on PATH; cannot fetch PR commit messages."
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise CommitMessagesFetchError(
            f"gh api repos/{repo}/pulls/{pr_number}/commits failed "
            f"(exit {exc.returncode}): {exc.stderr.strip()}"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise CommitMessagesFetchError(
            f"gh api repos/{repo}/pulls/{pr_number}/commits timed out after {exc.timeout}s"
        ) from exc
    return _parse_paginated_commits_to_list(result.stdout)


def _parse_paginated_commits_to_list(raw: str) -> list[str]:
    """Extract commit messages from a `gh api --paginate` JSON stream as a list.

    `gh api --paginate` concatenates each page's JSON array back-to-back
    into a single stream — e.g., ``[{...},{...}][{...}]`` — without a
    delimiter between arrays. The same pattern is parsed by
    ``scripts/ci/check_agentic_engineer_authorship.py:fetch_pr_commits``
    via ``json.JSONDecoder().raw_decode``; this helper applies the same
    streaming parse and returns commit messages as a list of strings,
    preserving every commit body intact (including blank-line
    paragraphs that would otherwise alias the inter-commit delimiter).
    """
    raw = raw.strip()
    if not raw:
        return []
    commits: list[str] = []
    decoder = json.JSONDecoder()
    idx = 0
    while idx < len(raw):
        try:
            value, end = decoder.raw_decode(raw, idx)
        except json.JSONDecodeError:
            # Skip past one character and retry; defensive guard against
            # malformed prefixes that aren't JSON. The reference parser
            # in `check_agentic_engineer_authorship.py` does not retry,
            # but it operates on tighter-controlled input.
            idx += 1
            continue
        if isinstance(value, list):
            for entry in value:
                msg = (entry or {}).get("commit", {}).get("message")
                if isinstance(msg, str) and msg.strip():
                    commits.append(msg.rstrip())
        elif isinstance(value, dict):
            # Single-commit case (rare). Defensive.
            msg = value.get("commit", {}).get("message")
            if isinstance(msg, str) and msg.strip():
                commits.append(msg.rstrip())
        idx = end
        while idx < len(raw) and raw[idx].isspace():
            idx += 1
    return commits


def _parse_paginated_commit_messages(raw: str) -> str:
    """Backward-compatible wrapper that returns the list as a joined string.

    Retained for the unit tests that were written before
    :func:`_parse_paginated_commits_to_list` existed. Production code
    uses the list-returning variant via :func:`pr_commit_messages`.
    Joining with ``"\n\n"`` is lossy when commit bodies contain blank
    paragraphs — DO NOT use this form for any precedence-sensitive
    parsing path.
    """
    return "\n\n".join(_parse_paginated_commits_to_list(raw))


def is_plan_pr(
    title: str,
    labels: Iterable[str],
    changed_files: Iterable[str],
) -> bool:
    """Plan PR detection per Component 2 rule 1.

    A PR is a plan PR if BOTH conditions hold:
      - title matches ``docs(roadmap):`` OR ``docs(<cycle>):``,
        OR the PR has the label ``plan-pr``;
      - AND every changed file is under ``docs/`` (no code paths). We
        use the broader ``docs/`` rather than just cycle-doc paths so
        that a plan PR can add supporting docs (ADR, engineering doc)
        in the same change.
    """
    label_match = any(label.strip().lower() == "plan-pr" for label in labels)
    title_match = bool(PLAN_TITLE_RE.match(title or ""))
    files = list(changed_files)
    if not files:
        return False
    docs_only = all(p.startswith("docs/") or p == "AGENTS.md" or p == "CLAUDE.md" for p in files)
    return (label_match or title_match) and docs_only


def status_completion_in_diff(diff: str) -> list[str]:
    """Find cycle docs whose frontmatter is being set to ``status: completed`` in this PR.

    Reads the unified diff and looks for added lines matching
    ``+status: completed`` inside a file under ``docs/roadmap/cycles/``.
    Returns the list of cycle doc file paths affected. The caller uses
    this to enforce: a PR that completes a cycle must not also be the
    PR that implements it (status transitions go in their own PR).
    """
    affected: list[str] = []
    current_file: str | None = None
    in_frontmatter = False
    seen_completed_in_frontmatter = False
    for line in diff.splitlines():
        if line.startswith("+++ b/"):
            # New file header. Flush prior state.
            if (
                seen_completed_in_frontmatter
                and current_file
                and current_file not in affected
            ):
                affected.append(current_file)
            current_file = line[len("+++ b/") :].strip()
            in_frontmatter = False
            seen_completed_in_frontmatter = False
            continue
        if not current_file or not current_file.startswith("docs/roadmap/cycles/"):
            continue
        # Naive frontmatter tracking inside the diff hunk: ``---`` delimiters
        # toggle the flag. False positives are acceptable here — the goal
        # is to flag obvious "added a status: completed line in a cycle
        # doc" cases, not to perfectly parse YAML.
        if line.startswith("+") and line[1:].strip() == "---":
            in_frontmatter = not in_frontmatter
            continue
        if line.startswith(" ") and line.strip() == "---":
            in_frontmatter = not in_frontmatter
            continue
        if (
            line.startswith("+")
            and in_frontmatter
            and re.match(r"\+\s*status:\s*[\"']?completed[\"']?\s*$", line)
        ):
            seen_completed_in_frontmatter = True
    # Flush trailing file.
    if seen_completed_in_frontmatter and current_file and current_file not in affected:
        affected.append(current_file)
    return affected


_TERMINAL_STATUSES = frozenset({"completed", "complete", "superseded", "abandoned", "absorbed"})


def is_terminal_status(status: str | None) -> bool:
    return (status or "").lower().strip() in _TERMINAL_STATUSES


def cycle_docs_transitioned_to_terminal(
    repo: str,
    base_ref: str,
    gh_token: str | None,
    changed_files: Iterable[str],
) -> list[str]:
    """Find cycle docs whose status transitions to terminal in this PR.

    Compares each modified cycle-doc file's status at the base ref vs the
    PR checkout. Returns the list of repo-relative paths that flipped
    from a non-terminal status (in-progress / draft / planned / …) to a
    terminal one (completed / complete / superseded / abandoned /
    absorbed).

    Replaces the prior diff-context-based detection
    (``status_completion_in_diff``), which missed transitions when
    ``gh pr diff`` omitted the opening ``---`` frontmatter fence from
    the hunk context — a real failure mode flagged by Codex P2 review
    on PR #1380. Reading the files directly via the GitHub contents API
    (and locally for the PR-head version) is robust to diff truncation.

    Raises :class:`BaseCycleDocFetchError` on transport failure; caller
    decides whether to fail-closed.
    """
    cycle_paths = [
        p
        for p in changed_files
        if p.startswith("docs/roadmap/cycles/cycle") and p.endswith(".md")
    ]
    if not cycle_paths:
        return []

    env = os.environ.copy()
    if gh_token:
        env["GH_TOKEN"] = gh_token

    transitioned: list[str] = []
    for path in cycle_paths:
        # Head status: read from the PR checkout (already on disk).
        head_path = REPO_ROOT / path
        if not head_path.exists():
            # File was deleted in the PR — not a transition-to-terminal.
            continue
        head_status, _ = read_cycle_frontmatter(head_path)
        if not is_terminal_status(head_status):
            continue  # head is non-terminal; no transition to terminal.

        # Base status: fetch via contents API at the immutable base SHA.
        try:
            result = subprocess.run(
                [
                    "gh",
                    "api",
                    f"repos/{repo}/contents/{path}?ref={base_ref}",
                    "--jq",
                    ".content",
                ],
                check=True,
                capture_output=True,
                text=True,
                env=env,
                timeout=60,
            )
        except FileNotFoundError as exc:
            raise BaseCycleDocFetchError(
                "gh CLI not on PATH; cannot read base-ref cycle doc."
            ) from exc
        except subprocess.CalledProcessError as exc:
            # 404 means the file is new in the PR — treat as "no base
            # status to compare against" rather than failure.
            if _is_gh_not_found_error(exc):
                # New file in PR; if head is terminal, that's a fresh
                # cycle being created already terminal — almost certainly
                # an error but not a transition the gate is meant to
                # catch (the cycle-doc-existence checks above handle
                # the "you can't cite a terminal cycle" path).
                continue
            raise BaseCycleDocFetchError(
                f"gh api contents/{path}?ref={base_ref} failed "
                f"(exit {exc.returncode}): {exc.stderr.strip()}"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise BaseCycleDocFetchError(
                f"gh api contents/{path}?ref={base_ref} timed out after {exc.timeout}s"
            ) from exc

        try:
            decoded = base64.b64decode(result.stdout.strip()).decode("utf-8")
        except (ValueError, UnicodeDecodeError) as exc:
            # Codex P2 #3 follow-up: fail-closed on decode failure
            # rather than silently skipping. A corrupt/unexpected
            # contents-API response on a cited cycle doc must surface
            # — silently dropping the file from transition detection
            # would re-open the bypass surface this function exists
            # to close. Mirrors the DiffFetchError / CommitMessages
            # FetchError fail-closed pattern.
            raise BaseCycleDocFetchError(
                f"failed to decode contents-API payload for {path} at "
                f"{base_ref}: {exc}"
            ) from exc

        base_status: str | None = None
        inside = False
        for line in decoded.split("\n"):
            stripped = line.strip()
            if stripped == "---":
                if not inside:
                    inside = True
                    continue
                break
            if not inside:
                continue
            if stripped.startswith("status:"):
                base_status = stripped[len("status:") :].strip().strip("\"'")
                break

        if base_status is not None and not is_terminal_status(base_status):
            transitioned.append(path)

    return transitioned


def build_trailer_input(pr_body: str, commits: list[str] | str) -> str:
    """Concatenate PR body and commits into the order trailers should be parsed in.

    Precedence (lowest → highest, with the last-write-wins behavior of
    ``parse_trailers`` meaning later text overrides earlier):

      1. Older commits first (the PR commit list is chronological;
         :func:`pr_commit_messages` returns commits oldest → newest).
      2. Tip commit (last commit) — the documented Sage convention
         puts trailers here.
      3. PR body LAST — authoritative; what the human / reviewer sees
         on GitHub. A correct ``Cycle:`` in the body overrides any
         stale value on an early commit (the bug this function fixes).

    Accepts ``commits`` as either a list of commit-message strings
    (preferred — preserves blank-line paragraphs inside individual
    commit bodies) or a single ``"\n\n"``-joined string (legacy; ONLY
    safe when no commit body contains a blank-line paragraph).
    """
    # Normalize the input into a list of non-empty commit messages.
    if isinstance(commits, str):
        if not commits.strip():
            return pr_body
        # Legacy delimited-string path. Lossy on multi-paragraph
        # commit bodies — production callers should pass a list.
        commit_list = [c for c in commits.split("\n\n") if c.strip()]
    else:
        commit_list = [c for c in commits if c.strip()]

    if not commit_list:
        return pr_body

    # Older commits come first in the returned order; the tip is the
    # last entry. Concatenate older→tip→body so the body wins on
    # last-write-wins parsing.
    parts: list[str] = []
    if len(commit_list) > 1:
        parts.append("\n\n".join(commit_list[:-1]))
    parts.append(commit_list[-1])  # tip commit
    parts.append(pr_body)
    return "\n\n".join(p for p in parts if p)


def is_bot_exempt(labels: Iterable[str]) -> bool:
    """Bot/automation label allowlist per CONTRIBUTING.md.

    PRs with any of these labels skip trailer enforcement entirely.
    """
    norm = {(lbl or "").strip().lower() for lbl in labels}
    return any(lbl in norm for lbl in BOT_EXEMPT_LABELS)


def terminal_status_error(cycle_id: str, doc: CycleDoc, pr_type: str, source: str) -> str | None:
    """Return a terminal-status error for ``doc`` if its status blocks citation."""
    status_norm = (doc.status or "").lower().strip()
    path = doc.path.relative_to(REPO_ROOT)
    source_suffix = f" in {source}" if source else ""
    if status_norm in {"completed", "complete"}:
        return (
            f"[cycle-doc] FAIL ({pr_type}): cycle `{cycle_id}` is "
            f"`status: {doc.status}` in `{path}`{source_suffix}; "
            "cannot reference a completed cycle from a new PR. Open a "
            "follow-up cycle for additional work."
        )
    if status_norm == "superseded":
        suffix = (
            f" (superseded by `{doc.superseded_by}`)"
            if doc.superseded_by
            else ""
        )
        return (
            f"[cycle-doc] FAIL ({pr_type}): cycle `{cycle_id}` has "
            f"`status: superseded`{suffix} in `{path}`{source_suffix}; "
            "cannot reference a superseded cycle. Use the successor cycle's id."
        )
    if status_norm in {"abandoned", "absorbed"}:
        return (
            f"[cycle-doc] FAIL ({pr_type}): cycle `{cycle_id}` is "
            f"`status: {doc.status}` in `{path}`{source_suffix}; cannot reference "
            "a terminated cycle from a new PR."
        )
    return None


def validate(
    title: str,
    body: str,
    labels: Iterable[str],
    changed_files: Iterable[str],
    diff: str,
    base_doc: CycleDoc | None = None,
    terminal_transitions: Iterable[str] | None = None,
) -> list[str]:
    """Run all checks. Returns a list of error messages; empty means pass."""
    errors: list[str] = []

    labels_list = list(labels)
    if is_bot_exempt(labels_list):
        # Bot/automation PRs are exempted by label per CONTRIBUTING.md
        # "Trailers" section. The exemption is rare and explicit (one
        # of four named labels); the PR review reactor and dependabot
        # carry these. Code-PR rules don't apply.
        return errors

    trailers = parse_trailers(body)
    plan = is_plan_pr(title, labels_list, changed_files)
    pr_type = "plan-pr" if plan else "code-pr"

    cycle_id = normalize_cycle_id(trailers.cycle or "")

    if plan:
        # Plan PR: Cycle: is required. We also need the cycle doc in
        # the diff (checked below after find_cycle_doc).
        if not cycle_id:
            errors.append(
                "[cycle-doc] FAIL (plan-pr): missing required `Cycle:` trailer.\n"
                "  Plan PRs must cite the cycle they describe.\n"
                "  Add to PR description (or last commit message):\n"
                "      Cycle: <N>\n"
            )
            return errors
    else:
        # Code PR: either Cycle: is present (cycle-tracked product code,
        # the dominant case) or Issue:/ProjectItem: is present (non-cycle
        # PR — drift, hotfix, dependabot bump). Bot-exempt PRs already
        # returned above.
        if not cycle_id and not trailers.issue and not trailers.project_item:
            errors.append(
                "[cycle-doc] FAIL (code-pr): missing trailer.\n"
                "  Either:\n"
                "    Cycle: <N>     (for product code tied to a cycle, "
                "PLUS Issue:/ProjectItem: as a secondary anchor), or\n"
                "    Issue: #<N>    (for drift / dependabot / hotfix "
                "PRs without a cycle, per CONTRIBUTING.md), or\n"
                "    ProjectItem: <id>\n"
                "  GitHub auto-close keywords (`Closes #N`, `Fixes #N`, "
                "`Resolves #N`) count as `Issue:`."
            )
            return errors

    doc: CycleDoc | None = None
    if cycle_id:
        doc = find_cycle_doc(cycle_id)
        if doc is None:
            errors.append(
                f"[cycle-doc] FAIL ({pr_type}): cycle `{cycle_id}` not found in "
                f"`docs/roadmap/cycles/`. Either fix the trailer or open a plan "
                "PR that creates the cycle doc first."
            )
            return errors

        # Terminal statuses that mean "do not cite this cycle from a new PR."
        # Spelling drift across older docs is reality: ``complete`` (no
        # ``-ed``) and ``Complete`` (capitalized) appear alongside the
        # canonical ``completed``. ``absorbed`` / ``abandoned`` are also
        # terminal. Treat all of these as block-cite.
        if error := terminal_status_error(cycle_id, doc, pr_type, "the PR checkout"):
            errors.append(error)

        # The PR can edit the cited cycle doc itself. In CI we therefore
        # also validate the protected base-ref copy; otherwise a PR could
        # change `status: completed` back to `in-progress` and cite the
        # stale cycle in the same diff.
        if base_doc is not None:
            if error := terminal_status_error(cycle_id, base_doc, pr_type, "the base ref"):
                errors.append(error)

    if plan:
        # Plan PR: the diff MUST include the cycle's own doc file. A plan
        # PR that doesn't touch its cycle's doc is mis-labelled.
        assert doc is not None  # plan PR without cycle_id already returned
        cycle_paths = [
            f for f in changed_files if f.startswith("docs/roadmap/cycles/")
        ]
        doc_relative = doc.path.relative_to(REPO_ROOT).as_posix()
        if doc_relative not in cycle_paths:
            errors.append(
                f"[cycle-doc] FAIL (plan-pr): plan PR cites `Cycle: {cycle_id}` "
                f"but does not modify `{doc_relative}`. Plan PRs must include "
                "the cycle doc they describe."
            )
    elif cycle_id and not trailers.issue and not trailers.project_item:
        # Code PR WITH Cycle but no Issue/ProjectItem: still required as
        # the secondary anchor (per CONTRIBUTING.md "For cycle PRs, both
        # Cycle: and Issue: (or ProjectItem:) are required").
        errors.append(
            "[cycle-doc] FAIL (code-pr): code PR cites a Cycle but no "
            "`Issue:` / `ProjectItem:` trailer. For cycle PRs both are "
            "required (CONTRIBUTING.md). GitHub auto-close keywords "
            "(`Closes #N`, `Fixes #N`, `Resolves #N`) count as `Issue:`."
        )

    if cycle_id and doc is not None:
        # Prefer the base-vs-head transition check (Codex P2 #3: avoids
        # diff-context misses when the frontmatter fence is outside the
        # hunk window). Fall back to the diff-based heuristic when no
        # transition set was supplied (in-memory tests, or when the
        # base-ref fetch was skipped).
        if terminal_transitions is not None:
            completed = list(terminal_transitions)
        else:
            completed = status_completion_in_diff(diff)
        if completed:
            # Same PR creates AND completes a cycle: that's a status-transition
            # PR that should be split from the implementation. Note: completing
            # a *different* cycle is fine (and common — a meta-PR can close
            # multiple cycles), so we only fail when the completed file
            # matches the PR's own cited cycle.
            doc_relative = doc.path.relative_to(REPO_ROOT).as_posix()
            if doc_relative in completed:
                errors.append(
                    f"[cycle-doc] FAIL ({pr_type}): same PR sets "
                    f"`status: completed` on `{doc_relative}` AND cites "
                    f"`Cycle: {cycle_id}` as the in-flight cycle. Open a "
                    "separate doc PR to flip status to completed after the "
                    "implementing PR merges."
                )

    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--pr-number",
        type=int,
        default=int(os.environ.get("PR_NUMBER", "0") or 0),
        help="PR number (defaults to $PR_NUMBER).",
    )
    parser.add_argument(
        "--repo",
        default=os.environ.get("REPO", "momentiq-ai/sage3c"),
        help="Repo in owner/name form (defaults to $REPO).",
    )
    parser.add_argument(
        "--title",
        default=os.environ.get("PR_TITLE", ""),
        help="PR title (defaults to $PR_TITLE).",
    )
    parser.add_argument(
        "--body",
        default=os.environ.get("PR_BODY", ""),
        help="PR body (defaults to $PR_BODY).",
    )
    parser.add_argument(
        "--labels-json",
        default=os.environ.get("PR_LABELS", "[]"),
        help="JSON array of label objects (defaults to $PR_LABELS).",
    )
    parser.add_argument(
        "--gh-token",
        default=os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN"),
    )
    parser.add_argument(
        "--base-ref",
        default=os.environ.get("PR_BASE_SHA") or os.environ.get("PR_BASE_REF") or "",
        help="Base commit/ref for base-ref cycle-doc status checks.",
    )
    args = parser.parse_args(argv)

    try:
        labels_raw = json.loads(args.labels_json or "[]")
    except json.JSONDecodeError:
        labels_raw = []
    labels = [
        (lbl.get("name") if isinstance(lbl, dict) else str(lbl))
        for lbl in labels_raw
        if lbl
    ]
    labels = [label for label in labels if label]

    if args.pr_number <= 0:
        print(
            "[cycle-doc] FAIL: PR_NUMBER missing or invalid. Set $PR_NUMBER or pass --pr-number.",
            file=sys.stderr,
        )
        return 1

    try:
        changed_files = pr_changed_files(args.repo, args.pr_number, args.gh_token)
    except ChangedFilesFetchError as exc:
        print(
            f"[cycle-doc] FAIL: cannot enumerate PR changed files: {exc}\n"
            "  Without the file list the gate cannot distinguish plan PR from "
            "code PR and would silently mis-classify. Failing closed.",
            file=sys.stderr,
        )
        return 1

    try:
        diff = pr_diff_patches(args.repo, args.pr_number, args.gh_token)
    except DiffFetchError as exc:
        print(
            f"[cycle-doc] FAIL: cannot fetch PR diff: {exc}\n"
            "  Without the diff the status-completion guard cannot fire and "
            "would silently allow a PR that both implements a cycle AND flips "
            "its status to completed. Failing closed.",
            file=sys.stderr,
        )
        return 1

    try:
        commit_messages = pr_commit_messages(args.repo, args.pr_number, args.gh_token)
    except CommitMessagesFetchError as exc:
        print(
            f"[cycle-doc] FAIL: cannot fetch PR commit messages: {exc}\n"
            "  Trailers placed on the last commit (the documented Sage "
            "workflow) would be invisible to the gate. Failing closed to "
            "avoid false-red rejection of PRs that follow the convention.",
            file=sys.stderr,
        )
        return 1

    # Build the parse body with explicit trailer precedence.
    # build_trailer_input concatenates older-commits → tip-commit →
    # PR-body, so parse_trailers' last-write-wins ordering means:
    #   1. PR body wins on duplicate keys (textually last segment).
    #   2. Tip commit (last commit) overrides any older commits.
    #   3. Older commits are additive fallback (e.g., a `Closes #N`
    #      left on an early commit by a tooling helper).
    body_for_parse = build_trailer_input(args.body, commit_messages)

    base_doc_for_cited_cycle: CycleDoc | None = None
    cycle_id = normalize_cycle_id(parse_trailers(body_for_parse).cycle or "")
    if cycle_id:
        if not args.base_ref:
            print(
                "[cycle-doc] FAIL: PR_BASE_SHA / --base-ref missing.\n"
                "  The gate must compare cited cycle-doc status against the "
                "protected base ref; reading only the PR checkout lets the PR "
                "rewrite terminal cycle status. Failing closed.",
                file=sys.stderr,
            )
            return 1
        try:
            base_doc_for_cited_cycle = base_cycle_doc(
                args.repo,
                cycle_id,
                args.base_ref,
                args.gh_token,
            )
        except BaseCycleDocFetchError as exc:
            print(
                f"[cycle-doc] FAIL: cannot read cited cycle doc from base ref: {exc}\n"
                "  Without the base-ref copy, a PR could change a completed or "
                "superseded cycle back to in-progress and bypass the terminal-status "
                "guard. Failing closed.",
                file=sys.stderr,
            )
            return 1

    # Codex P2 #3: detect terminal-status transitions via base-vs-head
    # status comparison rather than diff-context parsing. The diff path
    # missed transitions where the opening `---` fence fell outside the
    # default hunk context. Reading the files directly is robust to
    # truncation.
    transitions: list[str] = []
    if cycle_id and args.base_ref:
        try:
            transitions = cycle_docs_transitioned_to_terminal(
                args.repo,
                args.base_ref,
                args.gh_token,
                changed_files,
            )
        except BaseCycleDocFetchError as exc:
            print(
                f"[cycle-doc] FAIL: cannot read base-ref cycle docs for "
                f"terminal-transition check: {exc}\n"
                "  Without base-ref reads the same-PR completion guard "
                "can be bypassed by a hunk that omits the frontmatter "
                "fence. Failing closed.",
                file=sys.stderr,
            )
            return 1

    errors = validate(
        title=args.title,
        body=body_for_parse,
        labels=labels,
        changed_files=changed_files,
        diff=diff,
        base_doc=base_doc_for_cited_cycle,
        terminal_transitions=transitions,
    )

    if errors:
        for err in errors:
            print(err, file=sys.stderr)
        print(
            "\n[cycle-doc] See docs/roadmap/cycles/cycle318.4-ci-fallback-and-auto-merge.md "
            "(Component 2) for the gate specification.",
            file=sys.stderr,
        )
        return 1

    print(
        f"[cycle-doc] OK: PR #{args.pr_number} satisfies cycle-doc trailer requirements."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
