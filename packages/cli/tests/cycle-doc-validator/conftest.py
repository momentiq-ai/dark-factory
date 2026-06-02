"""Add the bundled cycle-doc-validator script directory to sys.path so
``import validate_cycle_doc`` resolves to ``packages/cli/src/cycle-doc-validator/``
when pytest runs from the package root.

This is the conftest equivalent of the original sage3c tests'
``sys.path.insert(0, str(Path(__file__).parent))`` — but the script no
longer lives next to its tests post-extraction, so we insert the script
dir explicitly.

We also auto-skip tests that depend on sage3c-specific cycle docs
(e.g., ``docs/roadmap/cycles/cycle318.4-*.md``) — those tests originally
asserted against the sage3c repo's own contents and are integration
fixtures rather than pure-logic tests. The pure-logic majority of the
corpus runs fine standalone.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

SCRIPT_DIR = (
    Path(__file__).resolve().parents[2] / "src" / "cycle-doc-validator"
)
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

# Tests that depend on sage3c-specific cycle docs being present at the
# detected REPO_ROOT (which is dark-factory when running here). Listed
# explicitly so the skip is auditable; future tests added without this
# guard will run + fail loudly rather than silently skip.
_SAGE3C_FIXTURE_DEPENDENT_TESTS = {
    "test_validate_code_pr_happy_path_with_issue_trailer",
    "test_validate_code_pr_happy_path_with_autoclose_keyword",
    "test_validate_code_pr_missing_issue_and_project_item_fails",
    "test_validate_plan_pr_must_include_cited_cycle_doc_in_diff",
    "test_validate_plan_pr_happy_path",
    "test_validate_status_completion_in_implementing_pr_fails",
    "test_validate_rejects_terminal_base_cycle_even_if_pr_doc_reopens_it",
}


def pytest_collection_modifyitems(config, items):
    """Skip tests that need sage3c's cycle docs.

    These tests rely on the consumer repo having ``docs/roadmap/cycles/``
    populated with specific cycle files. When running inside dark-factory
    (or any consumer that doesn't have those fixtures), skip with a
    structured reason so the skip is visible in CI output.
    """
    skip_marker = pytest.mark.skip(
        reason=(
            "depends on sage3c-specific cycle docs at "
            "docs/roadmap/cycles/; runs only against the source repo"
        )
    )
    for item in items:
        if item.name in _SAGE3C_FIXTURE_DEPENDENT_TESTS:
            item.add_marker(skip_marker)
