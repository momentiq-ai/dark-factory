"""Write PR↔cycle attribution into the GH Project's `Cycle Ref` text field.

Called from `.github/workflows/cycle-board.yml` for every PR event. Parses
the `Cycle: <N>` trailer from the PR body + commit messages (reusing the
regex from `validate_cycle_doc.py`), then writes that cycle ID to the
PR's project item via `updateProjectV2ItemFieldValue` with a TEXT input.

Failure model — fail-loud (per Cycle 326 spec § Commit 6):
  - No `Cycle:` trailer found → exit 0 (not every PR is cycle-tracked;
    dependabot bumps, drift fixes, etc. live without a Cycle: trailer).
  - PROJECT_TOKEN missing/invalid → exit 1 with `::error::` annotation.
  - `Cycle Ref` field doesn't exist on the project → exit 1, `::error::`.
  - addProjectV2ItemById fails (the same drift mode cycle 323 closed
    on the existing `Add PR to project board` step) → exit 1, `::error::`.
  - updateProjectV2ItemFieldValue rejects the mutation → exit 1, `::error::`.

Structural independence from the existing `Add PR to project board` step:
this script does its OWN `addProjectV2ItemById` (idempotent — returns the
existing item if already added), so the workflow's `continue-on-error:
true` on the existing step doesn't suppress this one.

Inputs (env vars; workflow sets):
  PR_NUMBER          — the PR number being attributed.
  PR_NODE_ID         — the PR's node ID (from
                       `${{ github.event.pull_request.node_id }}` or via
                       a graphql lookup on workflow_run events — both
                       paths supported via the workflow YAML).
  PR_BODY_FILE       — path to a file containing the PR body text.
                       Preferred over PR_BODY because it sidesteps
                       heredoc-delimiter-injection on GITHUB_OUTPUT.
                       The workflow writes the API-fetched body to
                       ${RUNNER_TEMP}/pr-${PR_NUMBER}-body.txt and
                       passes the path.
  PR_BODY            — fallback: the PR body text as a string. Used
                       only when PR_BODY_FILE is unset or unreadable.
  PROJECT_TOKEN      — classic PAT with `project` scope.
  PROJECT_OWNER      — defaults to 'momentiq-ai'.
  PROJECT_NUMBER     — defaults to '2'.
  REPO               — defaults to 'momentiq-ai/sage3c'. Used to fetch
                       commit messages.

Outputs: prints what it did to stdout; emits `::error::` on failures.

Spec: docs/superpowers/specs/2026-05-17-gh-project-continuous-sync.md § Commit 6
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from typing import Optional


# ─────────────────────────────────────────────────────────────────────────
# Token-scope split (per Codex P2 review on Plan PR #1562)
# ─────────────────────────────────────────────────────────────────────────
#
# Two tokens are passed in by `cycle-board.yml`:
#   GH_TOKEN       — already swapped to PROJECT_TOKEN for project mutations
#                    (`secrets.PROJECT_TOKEN || secrets.GITHUB_TOKEN`).
#                    PROJECT_TOKEN is a classic PAT with `project` scope
#                    ONLY — it cannot read `repos/{repo}/pulls/{pr}/commits`.
#   GITHUB_TOKEN_REPO — repo-scoped token, always present in CI as the
#                       default `secrets.GITHUB_TOKEN`. Used for PR/commits
#                       reads (issues/pulls API).
#
# The helpers below construct subprocess envs with the right token for
# each call site so we never write to projects with GITHUB_TOKEN and never
# read repo data with PROJECT_TOKEN.

def _repo_env() -> dict:
    """Env for repo-scoped reads (pulls/commits API)."""
    env = os.environ.copy()
    repo_token = (
        os.environ.get("GITHUB_TOKEN_REPO")
        or os.environ.get("GITHUB_TOKEN")
    )
    if repo_token:
        env["GH_TOKEN"] = repo_token
        # Remove PROJECT_TOKEN so a misconfigured subprocess can't fall
        # back to it.
        env.pop("PROJECT_TOKEN", None)
    return env


def _project_env() -> dict:
    """Env for ProjectV2 mutations.

    Prefers PROJECT_TOKEN explicitly so the `project` scope is in effect.
    Falls back to GH_TOKEN if PROJECT_TOKEN is unset (single-token mode).
    """
    env = os.environ.copy()
    project_token = os.environ.get("PROJECT_TOKEN")
    if project_token:
        env["GH_TOKEN"] = project_token
    return env


# Trailer regex — same shape as validate_cycle_doc.py:TRAILER_RE.
_TRAILER_RE = re.compile(
    r"^\s*(?P<key>[A-Za-z][A-Za-z0-9-]*):\s*(?P<value>.+?)\s*$",
    re.MULTILINE,
)


def parse_cycle_trailer(text: str) -> Optional[str]:
    """Return the LAST `Cycle:` trailer value in the text, normalized to
    a dotted-decimal id (e.g. `318.4`), or None.

    Last-write-wins matches validate_cycle_doc.py:parse_trailers.
    Normalization strips a leading `Cycle ` word and any text after the
    leading cycle-id token.
    """
    last_value: Optional[str] = None
    for m in _TRAILER_RE.finditer(text or ""):
        if m.group("key").lower() == "cycle":
            last_value = m.group("value").strip()
    if not last_value:
        return None
    # Normalize: strip leading "Cycle " word, accept only the leading
    # dotted-decimal token.
    candidate = re.sub(r"^[Cc]ycle\s+", "", last_value).strip()
    m = re.match(r"(\d+(?:\.\d+)*)", candidate)
    return m.group(1) if m else None


def fetch_commit_messages(repo: str, pr_number: int) -> str:
    """Fetch PR commit messages concatenated with newlines. Used as the
    body-extension input for parse_cycle_trailer.

    Failure here is non-fatal: log a warning and return empty string,
    falling back to PR body only. Trailer convention says the trailer
    lives on the PR body or last commit — body-only is still a valid
    surface.
    """
    try:
        result = subprocess.run(
            ["gh", "api", "--paginate",
             f"repos/{repo}/pulls/{pr_number}/commits"],
            capture_output=True, text=True, check=True, timeout=30,
            env=_repo_env(),
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
        msg = getattr(e, 'stderr', None) or str(e)
        print(f"::warning::commit fetch failed for PR #{pr_number}: {msg}")
        return ""
    parts: list[str] = []
    decoder = json.JSONDecoder()
    raw = result.stdout
    idx = 0
    while idx < len(raw):
        raw_slice = raw[idx:].lstrip()
        if not raw_slice:
            break
        offset = len(raw) - len(raw_slice)
        try:
            val, end = decoder.raw_decode(raw, offset)
        except json.JSONDecodeError:
            break
        if isinstance(val, list):
            for entry in val:
                m = (entry or {}).get("commit", {}).get("message")
                if isinstance(m, str) and m.strip():
                    parts.append(m.rstrip())
        idx = end
    return "\n\n".join(parts)


def lookup_project_id(owner: str, number: int) -> Optional[str]:
    """Resolve org/user → project number → project node id.

    Uses `repositoryOwner` so both User and Organization owners resolve.
    """
    query = (
        'query($owner: String!, $number: Int!) { '
        '  repositoryOwner(login: $owner) { '
        '    ... on ProjectV2Owner { projectV2(number: $number) { id } } '
        '  } '
        '}'
    )
    try:
        result = subprocess.run(
            ["gh", "api", "graphql",
             "-f", f"query={query}",
             "-f", f"owner={owner}",
             "-F", f"number={number}",
             "--jq", ".data.repositoryOwner.projectV2.id"],
            capture_output=True, text=True, check=True, timeout=30,
            env=_project_env(),
        )
    except subprocess.CalledProcessError as e:
        print(f"::error::project lookup failed: {(e.stderr or '').strip()}")
        return None
    pid = result.stdout.strip()
    if not pid or pid == "null":
        print(f"::error::project lookup returned empty id for {owner}/projects/{number}")
        return None
    return pid


def lookup_cycle_ref_field_id(project_id: str) -> Optional[str]:
    """Get the field ID of the `Cycle Ref` custom text field.

    Returns None and logs `::error::` if the field doesn't exist; the
    operator pre-step (gh project field-create) is documented in the
    Cycle 326 PR description.
    """
    query = (
        'query($projectId: ID!) { '
        '  node(id: $projectId) { '
        '    ... on ProjectV2 { '
        '      field(name: "Cycle Ref") { ... on ProjectV2Field { id } } '
        '    } '
        '  } '
        '}'
    )
    try:
        result = subprocess.run(
            ["gh", "api", "graphql",
             "-f", f"query={query}",
             "-f", f"projectId={project_id}",
             "--jq", ".data.node.field.id"],
            capture_output=True, text=True, check=True, timeout=30,
            env=_project_env(),
        )
    except subprocess.CalledProcessError as e:
        print(f"::error::Cycle Ref field lookup failed: {(e.stderr or '').strip()}. "
              "Verify the field exists: gh project field-list 2 --owner momentiq-ai")
        return None
    fid = result.stdout.strip()
    if not fid or fid == "null":
        print("::error::Cycle Ref field not found on the project. "
              "Create it: gh project field-create 2 --owner momentiq-ai --name 'Cycle Ref' --data-type TEXT")
        return None
    return fid


def ensure_item_id_for_pr(project_id: str, pr_node_id: str) -> Optional[str]:
    """Idempotent project-item add. Returns the item ID.

    Independent of the existing `Add PR to project board` workflow step
    — same mutation but our own call (per spec § Commit 6: structural
    independence prevents the existing step's continue-on-error: true
    from suppressing this script).
    """
    mutation = (
        'mutation($projectId: ID!, $contentId: ID!) { '
        '  addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) { '
        '    item { id } '
        '  } '
        '}'
    )
    try:
        result = subprocess.run(
            ["gh", "api", "graphql",
             "-f", f"query={mutation}",
             "-f", f"projectId={project_id}",
             "-f", f"contentId={pr_node_id}",
             "--jq", ".data.addProjectV2ItemById.item.id"],
            capture_output=True, text=True, check=True, timeout=30,
            env=_project_env(),
        )
    except subprocess.CalledProcessError as e:
        print(f"::error::addProjectV2ItemById failed for PR node {pr_node_id}: "
              f"{(e.stderr or '').strip()}. Verify PROJECT_TOKEN scope and Doppler sync (sage/dev:PROJECT_TOKEN).")
        return None
    item_id = result.stdout.strip()
    if not item_id or item_id == "null":
        print(f"::error::addProjectV2ItemById returned empty item id for PR node {pr_node_id}")
        return None
    return item_id


def write_cycle_ref(project_id: str, item_id: str, field_id: str, cycle_id: str) -> bool:
    """Write the cycle id (e.g. '326') to the Cycle Ref text field."""
    mutation = (
        'mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $text: String!) { '
        '  updateProjectV2ItemFieldValue(input: { '
        '    projectId: $projectId, '
        '    itemId: $itemId, '
        '    fieldId: $fieldId, '
        '    value: { text: $text } '
        '  }) { '
        '    projectV2Item { id } '
        '  } '
        '}'
    )
    try:
        subprocess.run(
            ["gh", "api", "graphql",
             "-f", f"query={mutation}",
             "-f", f"projectId={project_id}",
             "-f", f"itemId={item_id}",
             "-f", f"fieldId={field_id}",
             "-f", f"text={cycle_id}"],
            capture_output=True, text=True, check=True, timeout=30,
            env=_project_env(),
        )
        return True
    except subprocess.CalledProcessError as e:
        print(f"::error::Cycle Ref write failed: {(e.stderr or '').strip()}")
        return False


def _load_pr_body() -> str:
    """Resolve the PR body from PR_BODY_FILE (preferred) or PR_BODY.

    PR_BODY_FILE is the safe path: the workflow writes the API-fetched
    PR body to a temp file and passes the path, sidestepping
    heredoc-delimiter-injection on GITHUB_OUTPUT.

    PR_BODY is kept as a fallback for callers that still pass body text
    inline (e.g. unit tests, manual invocations).
    """
    body_file = os.environ.get("PR_BODY_FILE", "").strip()
    if body_file:
        try:
            with open(body_file, "r", encoding="utf-8") as f:
                return f.read()
        except OSError as e:
            print(f"::warning::PR_BODY_FILE='{body_file}' unreadable ({e}); falling back to PR_BODY")
    return os.environ.get("PR_BODY", "") or ""


def main() -> int:
    pr_number_raw = os.environ.get("PR_NUMBER", "")
    pr_node_id = os.environ.get("PR_NODE_ID", "")
    pr_body = _load_pr_body()
    repo = os.environ.get("REPO", "momentiq-ai/sage3c")
    project_owner = os.environ.get("PROJECT_OWNER", "momentiq-ai")
    try:
        project_number = int(os.environ.get("PROJECT_NUMBER", "2"))
    except ValueError:
        print("::error::PROJECT_NUMBER must be an integer")
        return 1

    if not pr_number_raw:
        print("::error::PR_NUMBER env var is empty")
        return 1
    try:
        pr_number = int(pr_number_raw)
    except ValueError:
        print(f"::error::PR_NUMBER must be an integer, got '{pr_number_raw}'")
        return 1

    if not pr_node_id:
        print("::error::PR_NODE_ID env var is empty")
        return 1

    # Parse Cycle: trailer from body + commits.
    commit_text = fetch_commit_messages(repo, pr_number)
    combined = "\n\n".join(p for p in (commit_text, pr_body) if p)
    cycle_id = parse_cycle_trailer(combined)

    if cycle_id is None:
        # Not every PR is cycle-tracked — see validate_cycle_doc.py
        # multi-anchor model. No trailer = no attribution needed.
        print(f"[cycle-ref] PR #{pr_number}: no Cycle: trailer found; skipping attribution")
        return 0

    project_id = lookup_project_id(project_owner, project_number)
    if not project_id:
        return 1

    field_id = lookup_cycle_ref_field_id(project_id)
    if not field_id:
        return 1

    item_id = ensure_item_id_for_pr(project_id, pr_node_id)
    if not item_id:
        return 1

    if not write_cycle_ref(project_id, item_id, field_id, cycle_id):
        return 1

    print(f"[cycle-ref] PR #{pr_number}: Cycle Ref set to '{cycle_id}' "
          f"(item {item_id} on project {project_owner}/{project_number})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
