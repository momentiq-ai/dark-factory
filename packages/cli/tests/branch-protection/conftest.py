"""Add the bundled branch-protection script directory to sys.path.

Also skips tests that depend on sage3c-specific artifacts
(``tools/branch-protection/spec.yaml`` at the consumer repo root,
``.github/workflows/agent-critic.yml``, etc.) — those tests originally
asserted against the sage3c repo's own contents and are integration
fixtures rather than pure-logic tests. The pure-logic majority of the
corpus runs fine standalone.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

SCRIPT_DIR = (
    Path(__file__).resolve().parents[2] / "src" / "branch-protection"
)
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

# Integration-fixture-dependent tests (sage3c-only). Listed explicitly
# so the skip is auditable.
_SAGE3C_FIXTURE_DEPENDENT_TESTS = {
    "test_audit_real_spec_yaml_parses_cleanly",
    "test_audit_workflow_supplies_vars_context_when_spec_audits_repo_variables",
    "test_agent_critic_trusted_surface_prs_take_rebind_path",
    "test_agent_critic_treats_agent_review_policy_as_trusted_surface",
    "test_agent_critic_treats_host_dependency_manifests_as_trusted_surface",
    "test_agent_critic_treats_gate_executed_scripts_as_trusted_surface",
    "test_agent_critic_strips_vendor_secrets_from_gate_prepare",
    "test_agent_critic_review_runs_in_review_cwd_so_rebind_uses_base_workspace",
    "test_agent_critic_review_push_is_normal_pr_only",
    "test_agent_critic_only_head_commit_failures_are_terminal_on_pull_requests",
    "test_agent_critic_gate_prepare_failure_continues_to_later_commits",
    "test_agent_critic_review_failure_continues_to_gate_push_and_later_commits",
    "test_agent_critic_doctor_step_runs_ci_doctor_with_all_three_keys",
}


def pytest_collection_modifyitems(config, items):
    skip_marker = pytest.mark.skip(
        reason=(
            "depends on sage3c-specific spec.yaml + workflow YAMLs; "
            "runs only against the source repo"
        )
    )
    for item in items:
        if item.name in _SAGE3C_FIXTURE_DEPENDENT_TESTS:
            item.add_marker(skip_marker)
