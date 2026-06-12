#!/usr/bin/env bash
# Reusable Evidence-Gated Validation **playwright (UI) route** producer command
# (momentiq-ai/dark-factory#193). Generalized from the dark-factory-dashboard
# dogfood (Cycle 21 PR-4).
#
# This is the `command` of the `playwright` route in
# `.agent-review/config.json:validation.verificationRoutes`. The
# @momentiq/dark-factory-cli route-runner (`df verify` / `df gate-push`) spawns
# it with NO shell — the route command is `command.trim().split(/\s+/)` then
# `spawn(argv[0], argv.slice(1))` — which is why the route command is the single
# token-pair `bash scripts/verify/playwright-route.sh` and ALL the real work
# (guards, Playwright, exit mapping) lives here.
#
# Exit-code contract (the 0/1/2 route contract):
#   0 — green: evidence captured, the routed UI surface(s) rendered + asserted.
#   1 — block: a routed UI surface failed to render/assert, OR a real producer
#       error (Playwright crashed, a guarded file is dirty). Fail closed.
#   2 — soft-skip: the producer cannot run HERE (Playwright not installed, or a
#       required auth storage-state is configured but absent). Mapped by the CLI
#       to `requiresHumanJudgment` — NOT a pass. We NEVER fabricate evidence.
#
# ── CONSUMER REFERENCE FILE — copy into your repo (e.g. scripts/verify/) and
#    OWN it. Adjust the env knobs at the top to your repo layout. Then arm the
#    `playwright` route's `command` to `bash <path-to-this-script>` in
#    .agent-review/config.json. `df skills install verify` does NOT overwrite it.
#
# Usage (normally invoked by the route-runner via `df verify --route playwright`):
#   bash scripts/verify/playwright-route.sh [--commit <ref>]

set -uo pipefail

EXIT_GREEN=0
EXIT_BLOCK=1
EXIT_SOFT_SKIP=2

# --- consumer-tunable knobs (env overrides) --------------------------------
# Directory where your web app + @playwright/test live (Playwright runs there).
WEB_DIR="${DF_UI_ROUTE_WEB_DIR:-web}"
# The producer config, relative to WEB_DIR.
ROUTE_CONFIG="${DF_UI_ROUTE_CONFIG:-playwright.ui-route.config.ts}"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "${REPO_ROOT}"

# Path of THIS script relative to the repo root — added to the clean-tree guard
# so a dirty producer (which would run DIFFERENT logic than the committed SHA)
# fails closed too. Computed dynamically so it works wherever you copy it.
SCRIPT_ABS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SCRIPT_REL="${SCRIPT_ABS#"${REPO_ROOT}/"}"

# --- resolve the SHA under review ------------------------------------------
# Prefer DF_VERIFY_COMMIT (exported by a route orchestrator that pins the gated
# commit), then an explicit --commit, then HEAD.
SHA_REF="${DF_VERIFY_COMMIT:-HEAD}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit) SHA_REF="${2:-HEAD}"; shift 2 ;;
    --commit=*) SHA_REF="${1#*=}"; shift ;;
    *) shift ;;
  esac
done
SHA="$(git rev-parse "${SHA_REF}" 2>/dev/null || echo "")"
if [[ -z "${SHA}" ]]; then
  echo "[playwright-route] FAIL: could not resolve commit '${SHA_REF}'." >&2
  exit "${EXIT_BLOCK}"
fi

# SHA-binding guard: the producer drives a browser against the CHECKED-OUT
# working tree (HEAD), so it can only honestly attest evidence for HEAD. If
# asked to produce evidence for a non-HEAD SHA, FAIL CLOSED rather than stamp a
# passing record whose screenshots actually reflect HEAD.
HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || echo "")"
if [[ "${SHA}" != "${HEAD_SHA}" ]]; then
  echo "[playwright-route] BLOCK: asked to produce evidence for ${SHA:0:12} but HEAD is ${HEAD_SHA:0:12}." >&2
  echo "[playwright-route] the producer validates the checked-out tree (HEAD) only; refusing to mis-bind evidence. Check out the target SHA and re-run." >&2
  exit "${EXIT_BLOCK}"
fi

# Clean-tree guard: the producer screenshots the WORKING TREE, but evidence
# binds to the committed SHA. If any file that affects either the rendered UI OR
# the route's execution/evidence contract is dirty or untracked, the capture
# would attest code that is NOT in ${SHA}. FAIL CLOSED. The guarded set is the
# UI surface (web/** + *.tsx) AND the route machinery itself (this script + the
# route config) — a dirty producer runs different logic than the committed SHA.
GUARDED_PATHS=(
  "${WEB_DIR}/**" '*.tsx'
  "${SCRIPT_REL}"
  '.agent-review/config.json'
)
if ! git diff-index --quiet HEAD -- "${GUARDED_PATHS[@]}" 2>/dev/null; then
  echo "[playwright-route] BLOCK: tracked UI or route-machinery files are dirty (uncommitted changes)." >&2
  echo "[playwright-route] the producer captures the working tree but evidence binds to ${SHA:0:12}; commit or stash changes under ${WEB_DIR}/**, *.tsx, ${SCRIPT_REL}, or .agent-review/config.json, then re-run." >&2
  exit "${EXIT_BLOCK}"
fi
UNTRACKED_GUARDED="$(git ls-files --others --exclude-standard -- "${GUARDED_PATHS[@]}" 2>/dev/null | head -1 || true)"
if [[ -n "${UNTRACKED_GUARDED}" ]]; then
  echo "[playwright-route] BLOCK: untracked UI/route-machinery file(s) present (e.g. ${UNTRACKED_GUARDED}) not in ${SHA:0:12}." >&2
  echo "[playwright-route] commit or remove untracked files under the guarded set so the capture matches the gated commit, then re-run." >&2
  exit "${EXIT_BLOCK}"
fi

echo "[playwright-route] producing UI evidence for ${SHA:0:12} (ref=${SHA_REF}, =HEAD, clean tree)" >&2

# Compute the UI paths this commit actually changed (parent..SHA), restricted to
# the route's trigger surface (web/** + *.tsx). Handed to the producer so it can
# FAIL CLOSED when a changed UI path has no mapped capture surface. Excludes
# deletions (D) — a removed file has no surface to render.
PARENT="$(git rev-parse "${SHA}^" 2>/dev/null || echo "")"
if [[ -n "${PARENT}" ]]; then
  CHANGED_UI_PATHS="$(git diff --name-only --diff-filter=ACMRT "${PARENT}" "${SHA}" -- "${WEB_DIR}/**" '*.tsx' 2>/dev/null || true)"
else
  # Root commit — list all tracked UI paths.
  CHANGED_UI_PATHS="$(git ls-files -- "${WEB_DIR}/**" '*.tsx' 2>/dev/null || true)"
fi
export DF_UI_ROUTE_CHANGED_PATHS="${CHANGED_UI_PATHS}"

# Anchor the evidence dir at the REPO ROOT (absolute), because Playwright runs
# with cwd=${WEB_DIR} — a relative path would land under ${WEB_DIR}.
OUT_DIR="${REPO_ROOT}/agent-reviews/quality-gates/ui/${SHA}"
mkdir -p "${OUT_DIR}"
export DF_UI_ROUTE_SHA="${SHA}"
export DF_UI_ROUTE_OUT="${OUT_DIR}"

# --- preflight: web tier present + Playwright installed --------------------
if [[ ! -d "${WEB_DIR}/node_modules/@playwright" ]]; then
  echo "[playwright-route] SOFT-SKIP: ${WEB_DIR}/ Playwright not installed (run \`cd ${WEB_DIR} && npm ci\`)." >&2
  echo "[playwright-route] not fabricating evidence — requiresHumanJudgment." >&2
  exit "${EXIT_SOFT_SKIP}"
fi

# --- auth storage-state gate (optional) ------------------------------------
# Public surfaces need no auth. If you configured an auth storage-state
# (DF_UI_ROUTE_STORAGE_STATE) but the file is absent (e.g. a cloud sandbox where
# your auth harness could not mint it), SOFT-SKIP rather than pass — we will not
# produce a protected-surface artifact we cannot legitimately authenticate.
if [[ -n "${DF_UI_ROUTE_STORAGE_STATE:-}" && ! -f "${DF_UI_ROUTE_STORAGE_STATE}" ]]; then
  echo "[playwright-route] SOFT-SKIP: DF_UI_ROUTE_STORAGE_STATE=${DF_UI_ROUTE_STORAGE_STATE} is set but the file is absent." >&2
  echo "[playwright-route] cannot authenticate the configured session; not fabricating evidence (requiresHumanJudgment)." >&2
  exit "${EXIT_SOFT_SKIP}"
fi

# --- run the producer -------------------------------------------------------
LOG_FILE="$(mktemp -t df-playwright-route.XXXXXX)"
trap 'rm -f "${LOG_FILE}"' EXIT

set +e
( cd "${WEB_DIR}" && npx playwright test --config "${ROUTE_CONFIG}" ) \
  >"${LOG_FILE}" 2>&1
RC=$?
set -e 2>/dev/null || true

# Surface the producer output (bounded) for the gate log / critic.
tail -n 120 "${LOG_FILE}" >&2 || true

if [[ ${RC} -eq 0 ]]; then
  echo "[playwright-route] OK — evidence in ${OUT_DIR}" >&2
  exit "${EXIT_GREEN}"
fi

echo "[playwright-route] BLOCK: producer failed (exit ${RC}) — see output above." >&2
exit "${EXIT_BLOCK}"
