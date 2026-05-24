"""Tests for scripts/ci/audit_branch_protection.py.

Cover the in-memory ``audit_in_memory`` entry point so we don't hit
GitHub during unit tests. The audit script's main() also has an
end-to-end live-fetch path that's exercised by the workflow itself.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).parent))

from audit_branch_protection import (  # noqa: E402
    REPO_ROOT,
    RepoVariableFetchError,
    audit_in_memory,
    fetch_repo_variables,
    load_spec,
    run_audit,
)


def _minimal_spec(**overrides):
    """Tiny well-formed spec; tests override fields as needed."""
    spec = {
        "schema_version": 1,
        "ruleset": {"id": 1, "name": "test", "enforcement": "active"},
        "branches": {
            "main": {
                "deletion_blocked": True,
                "non_fast_forward_blocked": True,
                "required_linear_history": True,
                "required_pull_request_reviews": {
                    "required_approving_review_count": 0,
                    "required_review_thread_resolution": True,
                    "allowed_merge_methods": ["squash"],
                },
                "required_status_checks": {
                    "strict_required_status_checks_policy": True,
                    "contexts": [
                        {"context": "PR Status Check", "status": "required"},
                        {"context": "schema-check", "status": "required"},
                    ],
                },
                "merge_queue": {
                    "enabled": True,
                    "merge_method": "SQUASH",
                    "grouping_strategy": "ALLGREEN",
                },
            }
        },
        "forbidden_bypasses": [],
    }
    if "branch_main" in overrides:
        spec["branches"]["main"].update(overrides.pop("branch_main"))
    spec.update(overrides)
    return spec


def _minimal_live(**overrides):
    rules = [
        {"type": "deletion"},
        {"type": "non_fast_forward"},
        {"type": "required_linear_history"},
        {
            "type": "pull_request",
            "parameters": {
                "required_approving_review_count": 0,
                "required_review_thread_resolution": True,
                "allowed_merge_methods": ["squash"],
            },
        },
        {
            "type": "required_status_checks",
            "parameters": {
                "strict_required_status_checks_policy": True,
                "required_status_checks": [
                    {"context": "PR Status Check"},
                    {"context": "schema-check"},
                ],
            },
        },
        {
            "type": "merge_queue",
            "parameters": {
                "merge_method": "SQUASH",
                "grouping_strategy": "ALLGREEN",
            },
        },
    ]
    return {
        "id": 1,
        "name": "test",
        "enforcement": "active",
        "rules": overrides.get("rules", rules),
    }


def test_audit_clean_spec_matches_live():
    report = audit_in_memory(_minimal_spec(), _minimal_live())
    assert report.ok, f"unexpected divergences: {[d.field for d in report.divergences]}"


def test_audit_missing_required_status_check_flagged():
    spec = _minimal_spec()
    live = _minimal_live(
        rules=[
            {"type": "deletion"},
            {"type": "non_fast_forward"},
            {"type": "required_linear_history"},
            {
                "type": "pull_request",
                "parameters": {
                    "required_approving_review_count": 0,
                    "required_review_thread_resolution": True,
                    "allowed_merge_methods": ["squash"],
                },
            },
            {
                "type": "required_status_checks",
                "parameters": {
                    "strict_required_status_checks_policy": True,
                    "required_status_checks": [{"context": "PR Status Check"}],
                    # schema-check is missing from live
                },
            },
            {"type": "merge_queue", "parameters": {"merge_method": "SQUASH"}},
        ]
    )
    report = audit_in_memory(spec, live)
    assert not report.ok
    assert any(
        d.field == "required_status_checks.contexts.required" for d in report.divergences
    )


def test_audit_planned_context_is_not_failed_when_absent_in_live():
    spec = _minimal_spec()
    spec["branches"]["main"]["required_status_checks"]["contexts"].append(
        {"context": "agent-critic", "status": "planned"}
    )
    report = audit_in_memory(spec, _minimal_live())
    assert report.ok, [d.field for d in report.divergences]


def test_audit_unplanned_live_context_flagged():
    spec = _minimal_spec()
    live = _minimal_live()
    for rule in live["rules"]:
        if rule["type"] == "required_status_checks":
            rule["parameters"]["required_status_checks"].append(
                {"context": "rogue-check"}
            )
    report = audit_in_memory(spec, live)
    assert any(
        d.field == "required_status_checks.contexts.unplanned_in_live"
        for d in report.divergences
    )


def test_audit_enforcement_drift_flagged():
    spec = _minimal_spec()
    live = _minimal_live()
    live["enforcement"] = "evaluate"
    report = audit_in_memory(spec, live)
    assert any(d.field == "ruleset.enforcement" for d in report.divergences)


def test_audit_review_count_drift_flagged():
    spec = _minimal_spec()
    spec["branches"]["main"]["required_pull_request_reviews"][
        "required_approving_review_count"
    ] = 2
    report = audit_in_memory(spec, _minimal_live())
    assert any(
        d.field == "pull_request.required_approving_review_count"
        for d in report.divergences
    )


def test_audit_merge_queue_grouping_drift_flagged():
    spec = _minimal_spec()
    live = _minimal_live()
    for rule in live["rules"]:
        if rule["type"] == "merge_queue":
            rule["parameters"]["grouping_strategy"] = "HEADGREEN"
    report = audit_in_memory(spec, live)
    assert any(d.field == "merge_queue.grouping_strategy" for d in report.divergences)


def test_audit_forbidden_repo_variable_present_fails():
    spec = _minimal_spec()
    spec["forbidden_bypasses"] = [
        {"kind": "repo_variable", "name": "SKIP_PR_CI"},
    ]
    report = audit_in_memory(
        spec, _minimal_live(), repo_vars=["SKIP_PR_CI", "SOMETHING_ELSE"]
    )
    assert any(
        "SKIP_PR_CI" in d.field for d in report.divergences
    )


def test_audit_forbidden_repo_variable_absent_passes():
    spec = _minimal_spec()
    spec["forbidden_bypasses"] = [
        {"kind": "repo_variable", "name": "SKIP_PR_CI"},
    ]
    report = audit_in_memory(spec, _minimal_live(), repo_vars=[])
    assert report.ok, [d.field for d in report.divergences]


def test_fetch_repo_variables_paginates_all_action_variables(monkeypatch):
    """Repo variable fetch must inspect every API page before bypass checks."""
    import audit_branch_protection as mod

    seen_args: list[str] = []

    def fake_run(args, **_kwargs):
        seen_args.extend(args)
        return subprocess.CompletedProcess(
            args=args,
            returncode=0,
            stdout="FIRST_PAGE_VAR\nSKIP_PR_CI\n",
            stderr="",
        )

    monkeypatch.setattr(mod.subprocess, "run", fake_run)

    assert mod.fetch_repo_variables("owner/repo") == [
        "FIRST_PAGE_VAR",
        "SKIP_PR_CI",
    ]
    assert "--paginate" in seen_args
    assert seen_args[seen_args.index("--paginate") + 1] == (
        "repos/owner/repo/actions/variables"
    )
    assert seen_args[-2:] == ["--jq", ".variables[].name"]


def test_audit_disabled_workflow_extras_flagged(tmp_path):
    workflows = tmp_path / "workflows"
    workflows.mkdir()
    # Create an unexpected *.yml.disabled file that the spec does not
    # list under known_violations.
    (workflows / "rogue.yml.disabled").write_text("name: rogue\n")
    spec = _minimal_spec()
    spec["forbidden_bypasses"] = [
        {"kind": "disabled_workflow", "pattern": "*.yml.disabled"},
    ]
    report = audit_in_memory(spec, _minimal_live(), workflows_dir=workflows)
    # The path is normalized relative to REPO_ROOT, but tmp_path is not
    # inside REPO_ROOT — the audit uses workflows_dir directly, so the
    # divergence message will include the absolute or repo-relative
    # path. We just check the field name is right.
    assert any(
        "disabled_workflow" in d.field for d in report.divergences
    )


def test_audit_disabled_workflow_clean_state_passes(tmp_path):
    workflows = tmp_path / "workflows"
    workflows.mkdir()
    # No .yml.disabled files, no known_violations
    spec = _minimal_spec()
    spec["forbidden_bypasses"] = [
        {"kind": "disabled_workflow", "pattern": "*.yml.disabled"},
    ]
    report = audit_in_memory(spec, _minimal_live(), workflows_dir=workflows)
    assert report.ok


def test_run_audit_fails_closed_when_repo_variable_fetch_errors(tmp_path, monkeypatch):
    """If spec.yaml has a `repo_variable` forbidden-bypass and the gh
    api call fails, the audit must record a divergence rather than
    silently skipping the check. Otherwise a regression where
    `SKIP_PR_CI` got re-introduced AND the audit token lost its
    variables-read scope at the same time would hide both.
    """
    import audit_branch_protection as mod

    spec_path = tmp_path / "spec.yaml"
    spec_path.write_text(
        """
schema_version: 1
ruleset:
  id: 42
branches:
  main:
    required_status_checks:
      contexts:
        - context: "PR Status Check"
          status: required
forbidden_bypasses:
  - kind: repo_variable
    name: SKIP_PR_CI
""".strip()
    )

    monkeypatch.setattr(
        mod,
        "fetch_live_ruleset",
        lambda repo, rid: {
            "id": 42,
            "name": "test",
            "enforcement": "active",
            "rules": [
                {
                    "type": "required_status_checks",
                    "parameters": {
                        "required_status_checks": [{"context": "PR Status Check"}]
                    },
                }
            ],
        },
    )

    def boom(_repo):
        raise mod.RepoVariableFetchError("permission denied")

    monkeypatch.setattr(mod, "fetch_repo_variables", boom)
    monkeypatch.delenv("REPO_ACTIONS_VARIABLES_JSON", raising=False)

    report = mod.run_audit(spec_path, "owner/repo")
    assert not report.ok
    assert any(
        "fetch_failure" in d.field for d in report.divergences
    ), [d.field for d in report.divergences]


def test_run_audit_uses_vars_context_when_repo_variable_api_is_unreadable(
    tmp_path, monkeypatch
):
    """CI can evaluate known repo-variable bypass names from the vars context."""
    import audit_branch_protection as mod

    spec_path = tmp_path / "spec.yaml"
    spec_path.write_text(
        """
schema_version: 1
ruleset:
  id: 42
branches:
  main:
    required_status_checks:
      contexts:
        - context: "PR Status Check"
          status: required
forbidden_bypasses:
  - kind: repo_variable
    name: SKIP_PR_CI
""".strip()
    )
    monkeypatch.setattr(
        mod,
        "fetch_live_ruleset",
        lambda repo, rid: {
            "id": 42,
            "name": "test",
            "enforcement": "active",
            "rules": [
                {
                    "type": "required_status_checks",
                    "parameters": {
                        "required_status_checks": [{"context": "PR Status Check"}]
                    },
                }
            ],
        },
    )

    def boom(_repo):
        raise mod.RepoVariableFetchError("permission denied")

    monkeypatch.setattr(mod, "fetch_repo_variables", boom)
    monkeypatch.setenv("REPO_ACTIONS_VARIABLES_JSON", '{"SKIP_PR_CI":"true"}')

    report = mod.run_audit(spec_path, "owner/repo")
    assert not report.ok
    assert not any("fetch_failure" in d.field for d in report.divergences)
    assert any("repo_variable=SKIP_PR_CI" in d.field for d in report.divergences)


def test_audit_real_spec_yaml_parses_cleanly():
    """The actual ``tools/branch-protection/spec.yaml`` must parse and
    declare the minimal required structure. This guards against typos in
    the file that ships in this PR."""
    spec = load_spec(REPO_ROOT / "tools" / "branch-protection" / "spec.yaml")
    assert "branches" in spec
    assert "main" in spec["branches"]
    main = spec["branches"]["main"]
    assert "required_status_checks" in main
    contexts = main["required_status_checks"]["contexts"]
    assert any(c.get("context") == "PR Status Check" for c in contexts)
    assert any(c.get("context") == "agent-critic" for c in contexts)
    assert any(c.get("context") == "cycle-doc-validation" for c in contexts)


def test_audit_workflow_supplies_vars_context_when_spec_audits_repo_variables():
    """Repo-variable forbidden-bypass checks need a CI-visible variable source."""
    spec = load_spec(REPO_ROOT / "tools" / "branch-protection" / "spec.yaml")
    assert any(
        isinstance(entry, dict) and entry.get("kind") == "repo_variable"
        for entry in spec.get("forbidden_bypasses", [])
    )

    workflow = yaml.safe_load(
        (REPO_ROOT / ".github" / "workflows" / "branch-protection-audit.yml").read_text(
            encoding="utf-8"
        )
    )
    audit_step = next(
        step for step in workflow["jobs"]["audit"]["steps"]
        if step.get("name") == "Run spec-vs-live audit"
    )
    assert audit_step["env"]["REPO_ACTIONS_VARIABLES_JSON"] == "${{ toJSON(vars) }}"


# Trusted-surface step name (issue #1434 — was "Codex P1 — secret exfil defense"
# pre-rebind). Tests pin against this exact name; if it's renamed, update here.
_TRUST_STEP_NAME = (
    "Detect trusted-surface changes (issue #1434 — gates parent-baseline rebind)"
)
_PER_COMMIT_ROLLBACK_STEP_NAME = (
    "Run gate-prepare + critic + gate-push per commit (rollback path post-332.1)"
)
_REVIEW_PUSH_STEP_NAME = "Run review-push (cycle 332.1 — per-push delta; DEFAULT)"


def _agent_critic_steps():
    workflow = yaml.safe_load(
        (REPO_ROOT / ".github" / "workflows" / "agent-critic.yml").read_text(
            encoding="utf-8"
        )
    )
    return workflow["jobs"]["agent-critic"]["steps"]


def _step_by_name(steps, name):
    return next(step for step in steps if step.get("name") == name)


def test_agent_critic_trusted_surface_prs_take_rebind_path():
    """Trusted-surface PRs must take the parent-baseline rebind path (issue #1434).

    The pre-#1434 posture was to fail closed and require admin merge. After
    the rebind, trusted-surface PRs check out the base ref into a side
    workspace, build the CLI from that trusted tree, and run review +
    gate-push from there — never executing PR-tree code with
    CURSOR_API_KEY in scope. This regression test asserts the rebind
    plumbing exists and that the old fail-closed manual-gate step is gone.
    """
    steps = _agent_critic_steps()
    names = [step.get("name") for step in steps]

    # The fail-closed manual-gate step must NOT exist anymore — the rebind
    # supersedes it. If a future refactor reintroduces a manual-gate step,
    # it must do so with a different name or this test will flag it.
    assert "Trusted-surface manual gate" not in names, (
        "Issue #1434 rebind landed but the fail-closed 'Trusted-surface manual gate' "
        "step is back. The rebind path is the canonical response to trusted-surface "
        "PRs; do not reintroduce the manual-gate failure unless the rebind is being "
        "removed entirely. See .github/workflows/agent-critic.yml header comments."
    )

    # The detect step still exists (renamed to flag the new role).
    trust_index = names.index(_TRUST_STEP_NAME)

    # The two-checkout rebind plumbing must exist, gated on
    # trusted_surface_touched=true. These steps materialize the BASE workspace
    # at .agent-review-base/ and seed PR_HEAD_SHA into its git db so the
    # BASE-built CLI can resolve it.
    rebind_checkout = _step_by_name(steps, "Checkout BASE ref into trusted workspace (rebind path)")
    rebind_fetch = _step_by_name(steps, "Fetch PR HEAD into trusted workspace (rebind path)")
    rebind_build = _step_by_name(
        steps, "Install agent-review deps + build CLI (trusted base workspace)"
    )
    for step in (rebind_checkout, rebind_fetch, rebind_build):
        cond = step.get("if", "")
        assert "steps.trust.outputs.trusted_surface_touched == 'true'" in cond, (
            f"Rebind step {step['name']!r} must be gated on trusted_surface_touched, "
            f"got: {cond!r}"
        )
        assert "github.event_name == 'pull_request'" in cond, (
            f"Rebind step {step['name']!r} must be gated on pull_request event, "
            f"got: {cond!r}"
        )

    # BASE-ref checkout must land in a side directory, NOT overlay the
    # PR workspace. Overlaying would let PR-tree files leak into the
    # trusted CLI's reach.
    assert rebind_checkout["with"]["path"] == ".agent-review-base"
    assert rebind_checkout["with"]["ref"] == "${{ github.event.pull_request.base.sha }}"

    # The rebind setup must precede both the trusted-surface per-commit
    # loop and the normal-PR review-push step where secret-bearing commands run.
    rebind_index = names.index(rebind_checkout["name"])
    rollback_index = names.index(_PER_COMMIT_ROLLBACK_STEP_NAME)
    review_push_index = names.index(_REVIEW_PUSH_STEP_NAME)
    assert trust_index < rebind_index < rollback_index
    assert trust_index < rebind_index < review_push_index


def test_agent_critic_treats_agent_review_policy_as_trusted_surface():
    """agent-review policy/guidance controls the secret-bearing CI commands."""
    steps = _agent_critic_steps()
    run_script = _step_by_name(steps, _TRUST_STEP_NAME)["run"]

    assert ".agent-review/" in run_script
    assert re.search(
        r"grep -E '.*\\\.agent-review/",
        run_script,
        flags=re.DOTALL,
    )


def test_agent_critic_treats_host_dependency_manifests_as_trusted_surface():
    """Secret-bearing gate-prepare must not run PR-controlled installs."""
    steps = _agent_critic_steps()
    run_script = _step_by_name(steps, _TRUST_STEP_NAME)["run"]

    for trusted_path in (
        "\\.npmrc",
        "backend/poetry\\.lock",
        "backend/pyproject\\.toml",
        "web/\\.npmrc",
        "web/package\\.json",
        "web/package-lock\\.json",
    ):
        assert trusted_path in run_script


def test_agent_critic_treats_gate_executed_scripts_as_trusted_surface():
    """Secret-bearing gate-prepare must not run PR-controlled gate scripts."""
    steps = _agent_critic_steps()
    run_script = _step_by_name(steps, _TRUST_STEP_NAME)["run"]
    trusted_surface_pattern = re.search(r"grep -E '([^']+)'", run_script).group(1)

    assert "scripts/" in run_script
    assert re.match(trusted_surface_pattern, "scripts/test/run-tests.sh")
    assert re.match(trusted_surface_pattern, "scripts/tests/test_verify_doppler_setup.sh")
    assert re.search(
        r"grep -E '.*scripts/",
        run_script,
        flags=re.DOTALL,
    )


def test_agent_critic_strips_vendor_secrets_from_gate_prepare():
    """gate-prepare must run with ALL critic-vendor keys unset.

    gate-prepare executes PR-controlled make targets, npm scripts, and
    Python tests as part of the configured `requiredQualityGates`. None of
    that code may run with any vendor secret in env. The step-level env
    exports CURSOR_API_KEY + GEMINI_API_KEY + XAI_API_KEY (for `review` +
    `gate-push` to inherit), so the gate-prepare invocation must
    explicitly strip all three with `env -u <KEY> -u <KEY> -u <KEY>`
    rather than relying on the variables being absent from the step env.

    Cycle 322.5 extends the secret-scope invariant from CURSOR_API_KEY
    alone (#1434 / PR #1450) to all three vendor keys for the multi-critic
    CI config. Cycle 322.7 Phase F adds CODEX_API_KEY (PR #1488) so the
    strip list grew from 3 to 4 keys; this test was updated accordingly.
    """
    steps = _agent_critic_steps()
    review_step = _step_by_name(steps, _PER_COMMIT_ROLLBACK_STEP_NAME)
    run_script = review_step["run"]
    step_env = review_step.get("env", {})

    # Issue #1434 (PR #1450) + Cycle 322.5 + Cycle 322.7 Phase F — the
    # step-level env exports all four vendor secrets so the rebind-path
    # subshells (cwd=BASE workspace) can inherit them. The invariant is
    # preserved by stripping every secret for gate-prepare specifically
    # with `env -u <KEY> -u <KEY> -u <KEY> -u <KEY>`. Both the export
    # and the strip must be present for all four.
    for vendor_secret in (
        "CURSOR_API_KEY",
        "CODEX_API_KEY",
        "GEMINI_API_KEY",
        "XAI_API_KEY",
    ):
        secrets_ref = "${{ secrets." + vendor_secret + " }}"
        assert step_env.get(vendor_secret) == secrets_ref, (
            f"Step env must export {vendor_secret} so the secret-bearing "
            "review/gate-push subshells can inherit it via the parent step env."
        )
    assert re.search(
        r'env\s+-u CURSOR_API_KEY\s+-u CODEX_API_KEY\s+-u GEMINI_API_KEY\s+-u XAI_API_KEY\s+\\?\s*'
        r'node tools/agent-review/dist/cli\.js gate-prepare '
        r'--commit "\$SHA"',
        run_script,
    ), (
        "gate-prepare must be invoked with `env -u CURSOR_API_KEY -u CODEX_API_KEY "
        "-u GEMINI_API_KEY -u XAI_API_KEY` so the PR-controlled make/npm/pytest "
        "subprocesses it spawns do not see any vendor secret (Cycle 322.5 extended "
        "#1434's single-key strip to three keys; Cycle 322.7 Phase F added "
        "CODEX_API_KEY for a total of four stripped vendor keys)."
    )


def test_agent_critic_review_runs_in_review_cwd_so_rebind_uses_base_workspace():
    """review + gate-push must honor REVIEW_CWD so the rebind path uses BASE binaries.

    REVIEW_CWD is set to '.' for normal PRs and '.agent-review-base' for
    trusted-surface PRs (computed from TRUSTED_REBIND in the per-commit
    loop). Both the review and gate-push invocations must `cd "$REVIEW_CWD"`
    before invoking node so that the BASE-built CLI binary + BASE
    .agent-review/config.json + BASE guidance/prompts are picked up.
    Without this, a trusted-surface PR would execute PR-tree CLI code with
    CURSOR_API_KEY in scope (the issue #1434 bootstrapping gap).
    """
    steps = _agent_critic_steps()
    review_step = _step_by_name(steps, _PER_COMMIT_ROLLBACK_STEP_NAME)
    run_script = review_step["run"]
    step_env = review_step.get("env", {})

    # TRUSTED_REBIND wiring must come from the trust detection output —
    # not from a freshly recomputed in-step heuristic that could drift.
    assert (
        step_env.get("TRUSTED_REBIND")
        == "${{ steps.trust.outputs.trusted_surface_touched }}"
    ), "TRUSTED_REBIND must mirror steps.trust.outputs.trusted_surface_touched."

    # The script must compute REVIEW_CWD from TRUSTED_REBIND and use it
    # as the working directory for both review and gate-push.
    assert 'REVIEW_CWD=".agent-review-base"' in run_script, (
        "Trusted-surface branch of REVIEW_CWD must point at the BASE workspace dir."
    )
    assert 'REVIEW_CWD="."' in run_script, (
        "Non-rebind branch of REVIEW_CWD must remain '.' (PR workspace)."
    )
    assert re.search(
        r'\(\s*cd\s+"\$REVIEW_CWD"\s+&&\s+\\\s+'
        r'node tools/agent-review/dist/cli\.js review --commit "\$SHA"',
        run_script,
    ), "review must invoke `cd \"$REVIEW_CWD\"` so the rebind path uses BASE binaries."
    assert re.search(
        r'\(\s*cd\s+"\$REVIEW_CWD"\s+&&\s+\\\s+'
        r'node tools/agent-review/dist/cli\.js gate-push --commit "\$SHA"',
        run_script,
    ), "gate-push must invoke `cd \"$REVIEW_CWD\"` so the rebind path uses BASE binaries."


def test_agent_critic_review_push_is_normal_pr_only():
    """Default review-push must not run for trusted-surface PRs."""
    steps = _agent_critic_steps()
    review_push_step = _step_by_name(steps, _REVIEW_PUSH_STEP_NAME)
    run_script = review_push_step["run"]
    step_env = review_push_step.get("env", {})
    cond = review_push_step.get("if", "")

    assert "steps.trust.outputs.trusted_surface_touched != 'true'" in cond, (
        "review-push runs the carry-forward cache gate for normal PRs only. "
        "Trusted-surface PRs use the stricter per-commit BASE-workspace rebind path."
    )
    assert "TRUSTED_REBIND" not in step_env, (
        "review-push must not be rebind-aware at runtime; trusted-surface PRs "
        "should skip the step entirely."
    )
    assert (
        step_env.get("HEAD_SHA") == "${{ github.event.pull_request.head.sha }}"
    ), "review-push must know the PR HEAD SHA whose cache/gate evidence it reads."
    assert ".agent-review-base" not in run_script, (
        "review-push should not contain a BASE-workspace branch; trusted-surface "
        "execution belongs to the per-commit rebind loop."
    )
    assert re.search(
        r'node tools/agent-review/dist/cli\.js review-push\s+\\\s+'
        r'--pr "\$PR_NUMBER" --base "\$BASE_SHA" --head "\$HEAD_SHA" --ci',
        run_script,
    ), "review-push must invoke the normal PR-workspace per-push gate."


def test_agent_critic_only_head_commit_failures_are_terminal_on_pull_requests():
    """Historical per-commit critic findings must not block no-amend PR iteration.

    The per-commit loop still reviews every SHA and reports every failure, but
    a pull-request check is merge-blocking only when the current head commit
    fails. Earlier commits can be intentionally superseded by later fixup
    commits, and the merge queue re-reviews the final squashed diff.
    """
    steps = _agent_critic_steps()
    review_step = _step_by_name(steps, _PER_COMMIT_ROLLBACK_STEP_NAME)
    run_script = review_step["run"]
    step_env = review_step.get("env", {})

    assert (
        step_env.get("HEAD_SHA")
        == "${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}"
    ), "The per-commit loop must know which SHA is terminal for this event."
    assert "declare -a PREPARE_FAILED_SHAS=()" in run_script
    assert "declare -a REVIEW_FAILED_SHAS=()" in run_script
    assert "declare -a BLOCKED_SHAS=()" in run_script
    assert "declare -a TERMINAL_SHAS=()" in run_script
    assert 'if [[ "$SHA" == "$HEAD_SHA" ]]; then' in run_script
    assert 'TERMINAL_SHAS+=("$SHA")' in run_script
    assert 'echo "::error::HEAD commit failed Agent Critic gate:' in run_script
    assert 'echo "::notice::Non-head per-commit Agent Critic failures were informational' in run_script
    assert "the merge-queue critic re-reviews on the squashed diff" in run_script


def test_agent_critic_gate_prepare_failure_continues_to_later_commits():
    """A historical setup failure must not prevent later commits from being reviewed."""
    steps = _agent_critic_steps()
    review_step = _step_by_name(steps, _PER_COMMIT_ROLLBACK_STEP_NAME)
    run_script = review_step["run"]

    assert re.search(
        r'if env\s+-u CURSOR_API_KEY\s+-u CODEX_API_KEY\s+-u GEMINI_API_KEY\s+-u XAI_API_KEY\s+\\?\s*'
        r'node tools/agent-review/dist/cli\.js gate-prepare --commit "\$SHA"; then',
        run_script,
    ), "gate-prepare must be wrapped so a historical failure can be aggregated."
    assert 'PREPARE_FAILED_SHAS+=("$SHA")' in run_script
    assert 'echo "::endgroup::"' in run_script
    assert "continue" in run_script


def test_agent_critic_review_failure_continues_to_gate_push_and_later_commits():
    """A historical review execution failure must be aggregated, not abort under set -e."""
    steps = _agent_critic_steps()
    review_step = _step_by_name(steps, _PER_COMMIT_ROLLBACK_STEP_NAME)
    run_script = review_step["run"]

    assert re.search(
        r'if \(\s*cd "\$REVIEW_CWD"\s+&&\s+\\\s+'
        r'node tools/agent-review/dist/cli\.js review --commit "\$SHA" --foreground \); then',
        run_script,
    ), "review must be wrapped so set -e does not abort on a historical review failure."
    assert 'REVIEW_FAILED_SHAS+=("$SHA")' in run_script
    assert "continuing to gate-push and later commits (#1593)" in run_script
    assert '"${REVIEW_FAILED_SHAS[@]}"' in run_script


def test_agent_critic_doctor_step_runs_ci_doctor_with_all_three_keys():
    """Cycle 322.5: the doctor step uses step-level env (safe — it only reads
    trusted-surface code) and runs the CI doctor with all 3 vendor keys so
    misconfigured credentials fail-fast before the per-commit gate loop."""
    steps = _agent_critic_steps()
    doctor_step = next(
        (
            step
            for step in steps
            if step.get("name", "").startswith("Doctor — verify all critic credentials")
        ),
        None,
    )
    assert (
        doctor_step is not None
    ), "Cycle 322.5: expected a 'Doctor — verify all critic credentials' step before the per-commit loop"

    step_env = doctor_step.get("env", {})
    assert (
        step_env.get("AGENT_REVIEW_DOCTOR_CI") == "1"
    ), "Cycle 322.5: AGENT_REVIEW_DOCTOR_CI must be '1' to skip local-only doctor checks"
    for vendor_secret in (
        "CURSOR_API_KEY",
        "CODEX_API_KEY",
        "GEMINI_API_KEY",
        "XAI_API_KEY",
    ):
        assert vendor_secret in step_env, (
            f"Cycle 322.5 / 322.7 Phase F: {vendor_secret} must be present in the doctor step env so the "
            "per-adapter doctor() check can validate the credential + resolve the model id."
        )

    doctor_run = doctor_step.get("run", "")
    assert (
        "make agent-review-doctor-ci" in doctor_run
    ), "Cycle 322.5: doctor step must invoke `make agent-review-doctor-ci`"

    # Cycle 322.5 + issue #1434: doctor must be rebind-aware. On
    # trusted-surface PRs, doctor runs from the BASE workspace
    # (.agent-review-base) so the BASE-built CLI + BASE adapter source
    # execute under the vendor keys, not the PR-tree code. The doctor
    # step does NOT have an `if:` guard skipping trusted-surface PRs —
    # fail-fast on credential issues applies equally to those PRs.
    assert (
        doctor_step.get("if") is None
        or "trusted_surface_touched != 'true'" not in str(doctor_step.get("if"))
    ), (
        "Cycle 322.5: doctor must NOT be skipped on trusted-surface PRs "
        "(use `cd .agent-review-base` for the rebind path instead — same "
        "safety envelope as review/gate-push)."
    )
    assert (
        doctor_step.get("env", {}).get("TRUSTED_REBIND")
        == "${{ steps.trust.outputs.trusted_surface_touched }}"
    ), "Doctor step must wire TRUSTED_REBIND from steps.trust output."
    assert "cd .agent-review-base" in doctor_run, (
        "Doctor must `cd .agent-review-base` on the rebind path so the "
        "BASE-built CLI runs (not the PR-tree CLI)."
    )

    # The doctor step must run BEFORE the per-commit gate loop so credential
    # failures don't waste runner minutes on gate-prepare.
    step_names = [s.get("name", "") for s in steps]
    doctor_idx = next(
        i for i, n in enumerate(step_names) if n.startswith("Doctor — verify all critic credentials")
    )
    gate_loop_idx = next(
        i for i, n in enumerate(step_names) if n == _PER_COMMIT_ROLLBACK_STEP_NAME
    )
    review_push_idx = next(i for i, n in enumerate(step_names) if n == _REVIEW_PUSH_STEP_NAME)
    assert (
        doctor_idx < gate_loop_idx
    ), "Cycle 322.5: doctor step must run before the per-commit rollback gate loop"
    assert (
        doctor_idx < review_push_idx
    ), "Cycle 322.5: doctor step must run before the default review-push gate"
