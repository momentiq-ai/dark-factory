#!/usr/bin/env python3
"""Cycle 318.4 Component 3 — branch-protection drift audit.

Reads ``tools/branch-protection/spec.yaml`` (the declarative source of
truth shipped by Cycle 318.3) and compares it against the live GitHub
Repository Ruleset. Exits non-zero on any divergence and prints a
structured field-by-field report (``[branch-protection-audit] FAIL:
...`` followed by one ``field: ... intended: ... live: ... detail:
...`` block per divergence — NOT a unified diff). Catches passive
drift (someone toggles a setting in the GitHub UI without a PR) AND
active drift (a PR weakens the spec without removing a corresponding
rule from the ruleset).

What gets compared:

  * Set of REQUIRED status-check contexts (status_checks where
    ``status: required`` in spec, vs ``required_status_checks`` array
    in the live rule). ``status: planned`` contexts are aspirational —
    they are NOT expected on the live ruleset yet, but the audit
    flags any LIVE context that is neither ``required`` nor ``planned``
    in the spec (drift: "live has something we didn't plan for").

  * Strict status-check policy: ``strict_required_status_checks_policy``
    in spec.required_status_checks vs the live rule parameters.

  * Pull-request rule settings: ``required_approving_review_count``,
    ``required_review_thread_resolution``, ``allowed_merge_methods``.

  * Merge-queue settings: ``merge_method``, ``grouping_strategy``,
    ``max_entries_to_build``, etc.

  * Forbidden bypass surfaces:
      - ``repo_variable`` entries: queried via paginated ``gh api``;
        any match is a hard fail.
      - ``disabled_workflow`` pattern: ``.github/workflows/*.yml.disabled``
        files in the working tree. Each file is a divergence unless
        the spec explicitly lists it under ``known_violations`` for an
        active cycle's resolution window.
      - ``pr_title_skip``: grep ``.github/workflows/*.yml`` for any
        check that gates on the configured title pattern (currently
        ``[skip ci]``).

Inputs:

  positional ``spec_path`` — path to ``tools/branch-protection/spec.yaml``.

Environment:

  GH_TOKEN — token with repo-read on rulesets. Without this the live
  fetch fails (gh CLI surfaces 401); the audit will print a clear
  diagnostic and exit non-zero.

  REPO_ACTIONS_VARIABLES_JSON — optional JSON object from the GitHub
  Actions ``vars`` context (``${{ toJSON(vars) }}``). Used only as a
  fallback when ``gh api repos/<repo>/actions/variables`` is not readable
  by the workflow token. This keeps forbidden repo-variable checks
  fail-closed locally while letting CI evaluate known kill-switch names
  without requiring a privileged PAT on PR-controlled workflow code.

Outputs:

  exit 0  — spec == live, no divergence;
  exit 1  — divergence (structured field-by-field report on stdout);
  exit 2  — usage / configuration error (e.g., spec.yaml missing).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

def _resolve_repo_root() -> Path:
    """Resolve the consumer repo root.

    Phase C extraction (cycle 331.1): same shape as
    ``cycle_doc_validator/validate_cycle_doc.py``. Resolution order:
    ``DF_REPO_ROOT`` env var → ``git rev-parse --show-toplevel`` → legacy
    ``__file__`` parents[2] fallback for in-tree pytest runs.
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
WORKFLOWS_DIR = REPO_ROOT / ".github" / "workflows"


@dataclass
class Divergence:
    field: str
    intended: Any
    live: Any
    detail: str = ""

    def render(self) -> str:
        lines = [f"  field: {self.field}"]
        lines.append(f"    intended: {self.intended!r}")
        lines.append(f"    live:     {self.live!r}")
        if self.detail:
            lines.append(f"    detail:   {self.detail}")
        return "\n".join(lines)


@dataclass
class AuditReport:
    divergences: list[Divergence] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.divergences

    def add(self, *args: Any, **kwargs: Any) -> None:
        self.divergences.append(Divergence(*args, **kwargs))

    def render(self) -> str:
        if self.ok:
            return "[branch-protection-audit] OK: spec.yaml matches live ruleset.\n"
        body = "\n".join(d.render() for d in self.divergences)
        return (
            "[branch-protection-audit] FAIL: spec.yaml vs live ruleset divergence:\n"
            f"{body}\n"
        )


def load_spec(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"spec.yaml not found at {path}")
    with path.open(encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    if not isinstance(data, dict):
        raise ValueError(f"{path} did not parse to a mapping")
    return data


def fetch_live_ruleset(repo: str, ruleset_id: int) -> dict[str, Any]:
    """Fetch the live ruleset via gh api. Raises on transport failure."""
    args = ["gh", "api", f"repos/{repo}/rulesets/{ruleset_id}"]
    try:
        result = subprocess.run(
            args,
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            "gh CLI not on PATH — install GitHub CLI or run inside an environment where it is available."
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            f"gh api repos/{repo}/rulesets/{ruleset_id} failed (exit {exc.returncode}):\n"
            f"  stderr: {exc.stderr.strip()}"
        ) from exc
    return json.loads(result.stdout)


class RepoVariableFetchError(RuntimeError):
    """Raised when the repo variables API is unreachable.

    We surface this rather than returning ``[]`` so the audit can fail
    closed when a forbidden ``repo_variable`` rule cannot be evaluated.
    Silently returning an empty list would hide a regression where
    ``SKIP_PR_CI`` got re-introduced and the audit step happened to lose
    its ``gh`` PATH or permission scope at the same time.
    """


def fetch_repo_variables(repo: str) -> list[str]:
    """List repo variable names via gh api.

    Raises :class:`RepoVariableFetchError` on any transport failure so
    the caller can decide whether to fail-closed (the default for
    ``check_forbidden_bypasses``) or skip the check explicitly.
    """
    try:
        result = subprocess.run(
            [
                "gh",
                "api",
                "--paginate",
                f"repos/{repo}/actions/variables",
                "--jq",
                ".variables[].name",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except FileNotFoundError as exc:
        raise RepoVariableFetchError(
            "gh CLI not on PATH; cannot enumerate repo variables for forbidden-bypass check."
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise RepoVariableFetchError(
            f"gh api repos/{repo}/actions/variables failed (exit {exc.returncode}): "
            f"{exc.stderr.strip()}"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise RepoVariableFetchError(
            f"gh api repos/{repo}/actions/variables timed out after {exc.timeout}s"
        ) from exc
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def repo_variables_from_actions_context() -> list[str] | None:
    """Return variable names from the GitHub Actions ``vars`` JSON fallback.

    ``None`` means the fallback was not supplied. An empty list means it
    was supplied and no variables are visible to the workflow.
    """
    raw = os.environ.get("REPO_ACTIONS_VARIABLES_JSON")
    if raw is None or not raw.strip():
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RepoVariableFetchError(
            "REPO_ACTIONS_VARIABLES_JSON is not valid JSON"
        ) from exc
    if not isinstance(data, dict):
        raise RepoVariableFetchError(
            "REPO_ACTIONS_VARIABLES_JSON must be a JSON object"
        )
    return [str(name) for name in data if name]


def extract_live_status_check_contexts(live: dict[str, Any]) -> tuple[list[str], bool | None]:
    """Pull (contexts, strict_required) from the live ruleset."""
    for rule in live.get("rules", []):
        if rule.get("type") == "required_status_checks":
            params = rule.get("parameters", {})
            contexts = [
                c.get("context") for c in params.get("required_status_checks", [])
            ]
            return [c for c in contexts if c], params.get(
                "strict_required_status_checks_policy"
            )
    return [], None


def extract_live_pr_rule(live: dict[str, Any]) -> dict[str, Any]:
    for rule in live.get("rules", []):
        if rule.get("type") == "pull_request":
            params = dict(rule.get("parameters") or {})
            params["__present__"] = True
            return params
    return {"__present__": False}


def extract_live_merge_queue(live: dict[str, Any]) -> dict[str, Any]:
    for rule in live.get("rules", []):
        if rule.get("type") == "merge_queue":
            params = dict(rule.get("parameters") or {})
            params["__present__"] = True
            return params
    return {"__present__": False}


def extract_live_linear(live: dict[str, Any]) -> bool:
    return any(r.get("type") == "required_linear_history" for r in live.get("rules", []))


def extract_live_deletion_blocked(live: dict[str, Any]) -> bool:
    return any(r.get("type") == "deletion" for r in live.get("rules", []))


def extract_live_non_fast_forward(live: dict[str, Any]) -> bool:
    return any(r.get("type") == "non_fast_forward" for r in live.get("rules", []))


def compare_status_check_contexts(
    spec: dict[str, Any],
    live: dict[str, Any],
    report: AuditReport,
) -> None:
    branch_spec = spec["branches"]["main"]
    rsc_spec = branch_spec.get("required_status_checks", {})
    raw_contexts = rsc_spec.get("contexts", [])

    required: set[str] = set()
    planned: set[str] = set()
    for entry in raw_contexts:
        if not isinstance(entry, dict):
            continue
        context = entry.get("context")
        if not context:
            continue
        status = entry.get("status", "required")
        if status == "required":
            required.add(context)
        elif status == "planned":
            planned.add(context)
        # Other statuses (e.g., 'audit') are advisory; ignored here.

    live_contexts, live_strict = extract_live_status_check_contexts(live)
    live_set = set(live_contexts)

    missing_required = required - live_set
    if missing_required:
        report.add(
            field="required_status_checks.contexts.required",
            intended=sorted(required),
            live=sorted(live_set),
            detail=f"missing in live: {sorted(missing_required)}",
        )

    unplanned_live = live_set - required - planned
    if unplanned_live:
        report.add(
            field="required_status_checks.contexts.unplanned_in_live",
            intended=sorted(required | planned),
            live=sorted(live_set),
            detail=(
                f"live ruleset requires checks NOT declared in spec.yaml: "
                f"{sorted(unplanned_live)}. Add them to "
                "branches.main.required_status_checks.contexts or remove "
                "from the live ruleset."
            ),
        )

    intended_strict = bool(rsc_spec.get("strict_required_status_checks_policy"))
    if live_strict is not None and intended_strict != bool(live_strict):
        report.add(
            field="required_status_checks.strict_required_status_checks_policy",
            intended=intended_strict,
            live=bool(live_strict),
        )


def compare_pull_request_rule(
    spec: dict[str, Any], live: dict[str, Any], report: AuditReport
) -> None:
    branch_spec = spec["branches"]["main"]
    pr_spec = branch_spec.get("required_pull_request_reviews", {})
    pr_live = extract_live_pr_rule(live)
    if not pr_live.get("__present__"):
        if pr_spec:
            report.add(
                field="pull_request_rule",
                intended=pr_spec,
                live=None,
                detail="spec declares pull-request rule but live ruleset has none.",
            )
        return

    for key in (
        "required_approving_review_count",
        "required_review_thread_resolution",
        "dismiss_stale_reviews_on_push",
        "require_code_owner_reviews",
        "require_last_push_approval",
    ):
        if key in pr_spec:
            # spec uses ``require_code_owner_reviews``; live uses
            # ``require_code_owner_review`` (no trailing s). Map both.
            live_key = key.rstrip("s") if key == "require_code_owner_reviews" else key
            if pr_live.get(live_key) != pr_spec[key]:
                report.add(
                    field=f"pull_request.{key}",
                    intended=pr_spec[key],
                    live=pr_live.get(live_key),
                )

    if "allowed_merge_methods" in pr_spec:
        intended = sorted(pr_spec["allowed_merge_methods"])
        live_methods = sorted(pr_live.get("allowed_merge_methods", []))
        if intended != live_methods:
            report.add(
                field="pull_request.allowed_merge_methods",
                intended=intended,
                live=live_methods,
            )


def compare_merge_queue(
    spec: dict[str, Any], live: dict[str, Any], report: AuditReport
) -> None:
    branch_spec = spec["branches"]["main"]
    mq_spec = branch_spec.get("merge_queue", {})
    mq_live = extract_live_merge_queue(live)
    if not mq_spec.get("enabled", True) and not mq_live.get("__present__"):
        return  # both disabled — fine.
    if not mq_live.get("__present__"):
        report.add(
            field="merge_queue",
            intended=mq_spec,
            live=None,
            detail="spec declares merge_queue but live ruleset has none.",
        )
        return
    for key in (
        "merge_method",
        "grouping_strategy",
        "check_response_timeout_minutes",
        "max_entries_to_build",
        "max_entries_to_merge",
        "min_entries_to_merge",
        "min_entries_to_merge_wait_minutes",
    ):
        if key in mq_spec and mq_live.get(key) != mq_spec[key]:
            report.add(
                field=f"merge_queue.{key}",
                intended=mq_spec[key],
                live=mq_live.get(key),
            )


def compare_linear_history(
    spec: dict[str, Any], live: dict[str, Any], report: AuditReport
) -> None:
    intended = bool(spec["branches"]["main"].get("required_linear_history", False))
    actual = extract_live_linear(live)
    if intended != actual:
        report.add(
            field="required_linear_history",
            intended=intended,
            live=actual,
        )


def compare_block_flags(
    spec: dict[str, Any], live: dict[str, Any], report: AuditReport
) -> None:
    branch_spec = spec["branches"]["main"]
    if "deletion_blocked" in branch_spec:
        intended = bool(branch_spec["deletion_blocked"])
        actual = extract_live_deletion_blocked(live)
        if intended != actual:
            report.add(
                field="deletion_blocked", intended=intended, live=actual,
            )
    if "non_fast_forward_blocked" in branch_spec:
        intended = bool(branch_spec["non_fast_forward_blocked"])
        actual = extract_live_non_fast_forward(live)
        if intended != actual:
            report.add(
                field="non_fast_forward_blocked", intended=intended, live=actual,
            )


def compare_enforcement(
    spec: dict[str, Any], live: dict[str, Any], report: AuditReport
) -> None:
    intended = spec.get("ruleset", {}).get("enforcement", "active")
    actual = live.get("enforcement")
    if actual != intended:
        report.add(field="ruleset.enforcement", intended=intended, live=actual)


def check_forbidden_bypasses(
    spec: dict[str, Any],
    repo_variables: list[str],
    workflows_dir: Path,
    report: AuditReport,
) -> None:
    """Verify each forbidden bypass entry is actually closed."""
    for entry in spec.get("forbidden_bypasses", []):
        if not isinstance(entry, dict):
            continue
        kind = entry.get("kind")
        if kind == "repo_variable":
            name = entry.get("name")
            if name and name in repo_variables:
                report.add(
                    field=f"forbidden_bypasses[repo_variable={name}]",
                    intended="absent",
                    live="present",
                    detail=(
                        f"Repo variable `{name}` is set in GitHub Actions. "
                        f"This was a documented bypass surface; remove it via "
                        f"`gh variable delete {name}`."
                    ),
                )
        elif kind == "disabled_workflow":
            pattern = entry.get("pattern", "*.yml.disabled")
            known = set(entry.get("known_violations", []) or [])
            # Match the bare filename glob (e.g., ``*.yml.disabled``)
            # against entries in the workflows directory. Paths are
            # rendered repo-relative when the workflows dir is under
            # REPO_ROOT; otherwise (unit tests with tmp_path) we use the
            # workflows-dir-relative path.
            #
            # GitHub Actions also accepts `.yaml`, so if the spec
            # pattern uses `*.yml.disabled` we also scan
            # `*.yaml.disabled` to catch the equivalent rename-disable
            # of a `.yaml` workflow.
            bare = pattern.split("/")[-1]
            extra_globs: list[str] = []
            if bare == "*.yml.disabled":
                extra_globs.append("*.yaml.disabled")
            matches = [
                p for p in workflows_dir.glob(bare) if p.is_file()
            ]
            for g in extra_globs:
                matches.extend(p for p in workflows_dir.glob(g) if p.is_file())
            found: list[str] = []
            for p in matches:
                try:
                    found.append(str(p.relative_to(REPO_ROOT)))
                except ValueError:
                    found.append(str(p.relative_to(workflows_dir)))
            found = sorted(found)
            extras = sorted(set(found) - known)
            still_present = sorted(set(found) & known)
            if extras:
                report.add(
                    field=f"forbidden_bypasses[disabled_workflow={pattern}]",
                    intended="no matches outside known_violations",
                    live=extras,
                    detail=(
                        "Disabled-workflow files exist that are not enumerated "
                        f"in spec.yaml's `known_violations`: {extras}. Either "
                        "delete them, re-enable, or add to allowed_bypasses."
                    ),
                )
            if still_present:
                report.add(
                    field=f"forbidden_bypasses[disabled_workflow={pattern}]",
                    intended="known_violations resolved before merge",
                    live=still_present,
                    detail=(
                        "Files listed in `known_violations` are still present. "
                        "Cycle 318.4 must resolve them (delete / re-enable / "
                        "move to allowed_bypasses)."
                    ),
                )
        elif kind == "pr_title_skip":
            pattern = entry.get("pattern", "[skip ci]")
            hits = grep_pr_title_skip(workflows_dir, pattern)
            if hits:
                report.add(
                    field=f"forbidden_bypasses[pr_title_skip={pattern}]",
                    intended="no workflow gates on this title token",
                    live=hits,
                    detail=(
                        f"Workflow files reference the forbidden title-skip "
                        f"token {pattern!r}: {hits}. Remove the if: clause."
                    ),
                )


def grep_pr_title_skip(workflows_dir: Path, pattern: str) -> list[str]:
    """Return relative paths of workflow files that gate on a forbidden PR title pattern.

    Strict match only: a workflow expression that calls
    ``contains(github.event.pull_request.title, '<pattern>')`` (single
    or double quotes, case-insensitive). Comments are stripped before
    matching so a documentation reference to ``[skip ci]`` does not
    trip the audit. A previous broad-fallback heuristic was removed —
    it false-positived on incidental prose that happened to mention
    both ``contains`` and ``pull_request.title`` without forming an
    ambient-bypass gate.
    """
    hits: list[str] = []
    escaped = re.escape(pattern)
    expr = re.compile(
        rf"contains\([^)]*pull_request\.title[^)]*[\"']{escaped}[\"']",
        re.IGNORECASE,
    )
    if not workflows_dir.exists():
        return hits
    # GitHub Actions accepts both `.yml` and `.yaml` per
    # https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions
    # — a forbidden title-skip gate hiding inside `foo.yaml` would
    # otherwise slip past the audit. Glob both extensions; sort the
    # combined list so the report is deterministic.
    workflow_paths = sorted(
        list(workflows_dir.glob("*.yml")) + list(workflows_dir.glob("*.yaml"))
    )
    for path in workflow_paths:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        stripped_lines = [
            (line.split("#", 1)[0] if "#" in line else line) for line in text.split("\n")
        ]
        joined = "\n".join(stripped_lines)
        if expr.search(joined):
            hits.append(str(path.relative_to(REPO_ROOT)))
    return hits


def run_audit(spec_path: Path, repo: str, ruleset_id: int | None = None) -> AuditReport:
    spec = load_spec(spec_path)
    rsid = ruleset_id or spec.get("ruleset", {}).get("id")
    if not rsid:
        raise ValueError(
            f"{spec_path} does not declare ruleset.id; cannot fetch live state."
        )
    live = fetch_live_ruleset(repo, int(rsid))
    # Only call the variables API if the spec has at least one
    # ``repo_variable`` forbidden-bypass entry. When no entry needs it,
    # skipping the API call avoids exercising a permission scope the
    # token may legitimately not have. When an entry exists, fail-closed
    # on transport failure so a regression in the audit's variable
    # visibility is surfaced rather than masked.
    needs_repo_vars = any(
        isinstance(e, dict) and e.get("kind") == "repo_variable"
        for e in spec.get("forbidden_bypasses", []) or []
    )
    report = AuditReport()
    if needs_repo_vars:
        try:
            repo_vars = fetch_repo_variables(repo)
        except RepoVariableFetchError as exc:
            try:
                repo_vars = repo_variables_from_actions_context()
            except RepoVariableFetchError as fallback_exc:
                report.add(
                    field="forbidden_bypasses[repo_variable].fetch_failure",
                    intended="readable repo-variables API or vars-context fallback",
                    live=f"{exc}; fallback failed: {fallback_exc}",
                    detail=(
                        "Cannot enumerate repo Actions variables to check forbidden-bypass "
                        "rules. Either grant the audit token repository Variables:read "
                        "access, pass REPO_ACTIONS_VARIABLES_JSON from `${{ toJSON(vars) }}`, "
                        "or remove the repo_variable entries from spec.yaml's "
                        "forbidden_bypasses. Fail-closed so a missing variable source cannot "
                        "silently hide a re-introduced kill switch like SKIP_PR_CI."
                    ),
                )
                repo_vars = []
            if repo_vars is None:
                report.add(
                    field="forbidden_bypasses[repo_variable].fetch_failure",
                    intended="readable repo-variables API or vars-context fallback",
                    live=str(exc),
                    detail=(
                        "Cannot enumerate repo Actions variables to check forbidden-bypass "
                        "rules. Either grant the audit token repository Variables:read "
                        "access, pass REPO_ACTIONS_VARIABLES_JSON from `${{ toJSON(vars) }}`, "
                        "or remove the repo_variable entries from spec.yaml's "
                        "forbidden_bypasses. Fail-closed so a missing variable source cannot "
                        "silently hide a re-introduced kill switch like SKIP_PR_CI."
                    ),
                )
                # Fall through to the standard audit path with an empty
                # repo_vars list — the repo_variable rules will not surface
                # additional divergences (the fetch_failure entry above is
                # the canonical signal), but disabled_workflow and
                # pr_title_skip checks STILL run. Without this, a combined
                # failure (variables API down AND a disabled-workflow file
                # reappears) would only surface the API failure and hide
                # the second regression.
                repo_vars = []
    else:
        repo_vars = []
    compare_enforcement(spec, live, report)
    compare_status_check_contexts(spec, live, report)
    compare_pull_request_rule(spec, live, report)
    compare_merge_queue(spec, live, report)
    compare_linear_history(spec, live, report)
    compare_block_flags(spec, live, report)
    check_forbidden_bypasses(spec, repo_vars, WORKFLOWS_DIR, report)
    return report


def audit_in_memory(
    spec: dict[str, Any],
    live: dict[str, Any],
    repo_vars: list[str] | None = None,
    workflows_dir: Path | None = None,
) -> AuditReport:
    """Pure-function entry point used by unit tests.

    Skips the live-fetch step; the caller injects spec / live / repo_vars
    directly. Makes the audit logic testable without hitting GitHub.
    """
    report = AuditReport()
    compare_enforcement(spec, live, report)
    compare_status_check_contexts(spec, live, report)
    compare_pull_request_rule(spec, live, report)
    compare_merge_queue(spec, live, report)
    compare_linear_history(spec, live, report)
    compare_block_flags(spec, live, report)
    check_forbidden_bypasses(
        spec,
        repo_vars or [],
        workflows_dir or WORKFLOWS_DIR,
        report,
    )
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "spec_path",
        nargs="?",
        default=str(REPO_ROOT / "tools" / "branch-protection" / "spec.yaml"),
        help="Path to spec.yaml (defaults to tools/branch-protection/spec.yaml).",
    )
    parser.add_argument(
        "--repo",
        default=os.environ.get("REPO") or os.environ.get("GITHUB_REPOSITORY") or "momentiq-ai/sage3c",
    )
    parser.add_argument(
        "--use-bundled-default-spec",
        action="store_true",
        help=(
            "Fall back to the bundled spec-default.yaml when the consumer "
            "repo has no tools/branch-protection/spec.yaml. Useful for "
            "first-run audits where the consumer hasn't yet authored their "
            "own desired-state spec."
        ),
    )
    args = parser.parse_args(argv)

    spec_path = Path(args.spec_path)
    if args.use_bundled_default_spec and not spec_path.exists():
        bundled = Path(__file__).resolve().parent / "spec-default.yaml"
        if bundled.exists():
            spec_path = bundled
            print(
                f"[branch-protection-audit] using bundled default spec: {bundled}",
                file=sys.stderr,
            )
    args.spec_path = str(spec_path)

    try:
        report = run_audit(Path(args.spec_path), args.repo)
    except FileNotFoundError as exc:
        print(f"[branch-protection-audit] FAIL: {exc}", file=sys.stderr)
        return 2
    except ValueError as exc:
        print(f"[branch-protection-audit] FAIL: {exc}", file=sys.stderr)
        return 2
    except RuntimeError as exc:
        print(f"[branch-protection-audit] FAIL: {exc}", file=sys.stderr)
        return 1

    print(report.render())
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
