// packages/cli/src/handoff/links.ts
//
// Link ref canonicalization, resolution, extraction, formatting.
// PORT FROM dark-factory-platform .claude/skills/handoff/scripts/lib.sh@a6f711b
// lines 222-253 (canonicalize_link_ref), 262-337 (resolve_link_ref),
// 352-367 (extract_linked_items).
//
// The bash uses \x1e (RS) as a kind/display/title delimiter to be tab-safe
// across an `awk -F` split. The TS port returns a structured `LinkRefResolved`
// object so no delimiter is needed — tab-in-title preservation is automatic.
// The behavioral assertion is exercised in Task 17 (handoff-verb.test.ts)
// where a PR title with an embedded tab is stubbed and the entry render
// must preserve it.
//
// `HANDOFF_LABEL` is intentionally a LOCAL const here, NOT imported from
// ./index.js. Rationale: index.ts is the v1 (Cycle 8) module slated for
// deletion at Task 22; importing the label name from it would couple this
// permanent module to a doomed one and break at Task 22. The same indirection
// reasoning applies that already routes HandoffError through ./ports.js
// instead of ./index.js directly. If we later want one canonical spelling of
// the label, a future task can centralize it in a permanent module — out of
// scope for Task 5.

import { HandoffError, type GhClient } from "./ports.js";
import { MARKER_OPEN, MARKER_CLOSE } from "./markers.js";

const HANDOFF_LABEL = "handoff";

export interface LinkRefCanonical {
  /** "pr" | "issue" | "" (unknown — caller treats as "any kind") */
  readonly kind: "" | "pr" | "issue";
  /** Display form: "#N" (same-repo) or "owner/repo#N" (cross-repo). */
  readonly display: string;
}

export interface LinkRefResolved {
  readonly kind: "pr" | "issue";
  readonly display: string;
  readonly title: string;
}

/**
 * Canonicalize a link ref to (kind, display) WITHOUT any gh fetch. Used by
 * --unlink (which doesn't need a title — it just needs to match an existing
 * entry's canonical display ref). Mirrors bash `canonicalize_link_ref`.
 */
export function canonicalizeLinkRef(input: string): LinkRefCanonical {
  let kind: "" | "pr" | "issue" = "";
  let ref = input;
  if (ref.startsWith("pr:")) {
    kind = "pr";
    ref = ref.slice(3);
  } else if (ref.startsWith("issue:")) {
    kind = "issue";
    ref = ref.slice(6);
  }
  // URL forms — PR.
  const pullMatch = ref.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (pullMatch) {
    return { kind: "pr", display: `${pullMatch[1]}#${pullMatch[2]}` };
  }
  // URL forms — Issue.
  const issuesMatch = ref.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/(\d+)/);
  if (issuesMatch) {
    return { kind: "issue", display: `${issuesMatch[1]}#${issuesMatch[2]}` };
  }
  // owner/repo#N
  if (ref.includes("#")) {
    return { kind, display: ref };
  }
  // bare number
  return { kind, display: `#${ref}` };
}

/** Defensive ceiling on handoff-link graph nodes walked during cycle
 * detection. Real programs are an umbrella + a handful of members, far under
 * this; the bound only guarantees termination on pathological input. (No
 * handoff→handoff link data exists in any repo today — the historical blanket
 * ban prevented it — so in practice the walk terminates near-immediately.) */
const MAX_CYCLE_WALK_NODES = 256;

/**
 * Same-repo issue numbers linked from a handoff body's `**Linked work items:**`
 * section. Matches ONLY `- issue #N — …` entries: PR entries (`- pr …`) can't
 * be handoff issues, and cross-repo issue links (`- issue owner/repo#N — …`)
 * are deliberately treated as leaves (see the cross-repo note on
 * `assertLinkAcyclic`). Reuses `extractLinkedItems` so the in-marker scoping is
 * identical to every other reader.
 */
function sameRepoLinkedIssues(body: string): number[] {
  const out: number[] = [];
  for (const entry of extractLinkedItems(body)) {
    const m = entry.match(/^- issue #([0-9]+) — /);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

/**
 * Refuse a handoff→handoff link ONLY when it would close a cycle — i.e. the
 * target handoff already reaches back to the source handoff through its own
 * same-repo handoff links. Acyclic links (umbrella → member) are allowed; this
 * is the real cycle-detection that replaces the historical blanket ban
 * (dark-factory#229).
 *
 * Bounded: a `visited` set guarantees termination even on malformed cyclic
 * data, and each reachable node costs one `gh issue view`. gh failures
 * mid-walk are treated as leaves (an unreachable node can't extend a cycle),
 * so the ONLY thing this throws is the cycle refusal.
 *
 * Scope — same-repo only. The source handoff is always in the current repo;
 * cross-repo issue links are leaves (not followed), and cross-repo TARGETS
 * skip the walk entirely (see `resolveLinkRef`). All current readers
 * (`/rehydrate`, `/accept`, `/handoffs`) are depth-1 / non-recursive, so a
 * cross-repo cycle — which this does not detect — still cannot cause an
 * infinite loop. A first-class cross-repo program model is deferred to
 * issue #229 Proposal B.
 */
async function assertLinkAcyclic(
  sourceIssue: number,
  targetNum: number,
  targetBody: string,
  gh: GhClient,
): Promise<void> {
  const refuse = (): never => {
    throw new HandoffError(
      `refusing to link #${targetNum}: it would close a link-cycle back to this handoff (#${sourceIssue}). ` +
        "Handoff links form a one-directional DAG (umbrella → members), never a cycle.",
    );
  };
  if (targetNum === sourceIssue) refuse(); // direct self-link
  const visited = new Set<number>([targetNum]);
  // Seed the frontier from the ALREADY-fetched target body so we don't
  // re-fetch the target as the first walk node.
  const queue: number[] = sameRepoLinkedIssues(targetBody);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === sourceIssue) refuse();
    if (visited.has(cur)) continue;
    visited.add(cur);
    if (visited.size > MAX_CYCLE_WALK_NODES) return; // defensive bound — stop walking
    let body: string;
    try {
      body = (await gh.issueView(cur)).body;
    } catch {
      continue; // unreachable node = leaf; can't extend a cycle
    }
    for (const n of sameRepoLinkedIssues(body)) queue.push(n);
  }
}

/**
 * Resolve a link ref to (kind, display, title) WITH a gh fetch.
 * PR-first per spec §3: a bare 42 is a PR if it resolves; else tried as an
 * issue. A `pr:N` / `issue:N` prefix short-circuits auto-detection.
 *
 * `ctx.sourceIssue` is the handoff issue the link is being written INTO (the
 * source of the edge). When present and the resolved target is a same-repo
 * handoff issue, the link is refused ONLY if it would close a cycle
 * (dark-factory#229). When absent — e.g. `--new`, where the source issue does
 * not exist yet and therefore cannot be the target of any back-link — no cycle
 * is possible, so handoff targets are allowed without a walk.
 *
 * Throws HandoffError on:
 *   - project URL (deferred to Phase 12.2 per OQ-12.7)
 *   - invalid ref shape
 *   - ref 0 / leading-zero
 *   - both PR and issue lookups fail (not found)
 *   - a same-repo handoff target that would close a link-cycle back to
 *     `ctx.sourceIssue` (true cycle-detection; acyclic umbrella→member links
 *     are allowed)
 */
export async function resolveLinkRef(
  input: string,
  gh: GhClient,
  ctx?: { sourceIssue?: number },
): Promise<LinkRefResolved> {
  let kind: "" | "pr" | "issue" = "";
  let ref = input;
  if (ref.startsWith("pr:")) {
    kind = "pr";
    ref = ref.slice(3);
  } else if (ref.startsWith("issue:")) {
    kind = "issue";
    ref = ref.slice(6);
  }

  // Project URLs — explicitly refused per spec §3 (OQ-12.7).
  // Covers both per-repo (https://github.com/o/r/projects/N) and per-org
  // (https://github.com/orgs/o/projects/N) shapes.
  if (
    /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/projects\//.test(ref) ||
    /^https?:\/\/[^/]+\/orgs\/[^/]+\/projects\//.test(ref)
  ) {
    throw new HandoffError(
      `link ref '${input}': GitHub project-item linkage is DEFERRED to ` +
        "Phase 12.2 (spec §3 / OQ-12.7). For Phase 12.1, link PRs and issues only.",
    );
  }

  let ownerRepo = "";
  let numberStr = "";
  let display = "";

  const pullMatch = ref.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  const issuesMatch = ref.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/(\d+)/);
  if (pullMatch) {
    kind = "pr";
    ownerRepo = pullMatch[1]!;
    numberStr = pullMatch[2]!;
    display = `${ownerRepo}#${numberStr}`;
  } else if (issuesMatch) {
    kind = "issue";
    ownerRepo = issuesMatch[1]!;
    numberStr = issuesMatch[2]!;
    display = `${ownerRepo}#${numberStr}`;
  } else if (ref.includes("#")) {
    const idx = ref.indexOf("#");
    ownerRepo = ref.slice(0, idx);
    numberStr = ref.slice(idx + 1);
    display = `${ownerRepo}#${numberStr}`;
  } else {
    numberStr = ref;
    display = `#${numberStr}`;
  }

  if (!/^[0-9]+$/.test(numberStr)) {
    throw new HandoffError(
      `link ref '${input}' is not a number, owner/repo#N, or supported URL (pull/issues).`,
    );
  }
  if (numberStr === "0" || /^0/.test(numberStr)) {
    throw new HandoffError(
      `link ref '${input}' must reference a positive integer (got '${numberStr}').`,
    );
  }
  const num = Number(numberStr);
  const opts = ownerRepo ? { repo: ownerRepo } : undefined;

  let title = "";
  let resolvedKind: "pr" | "issue" | "" = kind;

  // PR-first lookup (unless kind already pinned to "issue").
  if (kind === "" || kind === "pr") {
    try {
      const pr = await gh.prView(num, opts);
      title = pr.title;
      resolvedKind = "pr";
    } catch {
      title = "";
    }
  }
  // Fall through to issue lookup if PR didn't resolve AND kind allows.
  if (title === "" && (kind === "" || kind === "issue")) {
    try {
      const issue = await gh.issueView(num, opts);
      title = issue.title;
      resolvedKind = "issue";
      // dark-factory#229 — handoff→handoff links are ALLOWED unless they would
      // close a cycle. Same-repo targets only (`ownerRepo === ""`); the source
      // handoff is always current-repo. No `sourceIssue` (e.g. `--new`) ⇒ the
      // source can't yet be a back-link target ⇒ no cycle possible ⇒ allow.
      // `assertLinkAcyclic` swallows its own gh failures (treats unreachable
      // nodes as leaves), so its only throw is the HandoffError cycle refusal,
      // which the catch below re-raises.
      if (
        ctx?.sourceIssue !== undefined &&
        ownerRepo === "" &&
        issue.labels.some((l) => l.name === HANDOFF_LABEL)
      ) {
        await assertLinkAcyclic(ctx.sourceIssue, num, issue.body, gh);
      }
    } catch (err) {
      if (err instanceof HandoffError) throw err; // re-raise cycle refusal
      // otherwise fall through to "not found" error
    }
  }

  if (!title || !resolvedKind) {
    throw new HandoffError(
      `ref '${input}' not found as PR or Issue in ${ownerRepo || "this repo"}.`,
    );
  }
  return { kind: resolvedKind, display, title };
}

/**
 * Extract '- (pr|issue) <ref> — <title>' lines from the LATEST agent-context
 * block's `**Linked work items:**` section. Reads body, returns one entry per
 * line. Returns empty array when there's no well-formed marker block or no
 * linked-items section within it.
 *
 * Used uniformly by handoff-verb (write path), do_rehydrate (read path), and
 * handoffs-verb (stack list) — so the canonical link set is the same in all
 * three. A stale `**Linked work items:**` section OUTSIDE the latest markers
 * does not pollute any of them.
 *
 * PORT FROM bash extract_linked_items (lib.sh:352-367).
 */
export function extractLinkedItems(body: string): readonly string[] {
  const lines = body.split("\n");
  let lastOpen = -1;
  let lastClose = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(MARKER_OPEN)) lastOpen = i;
    if (lines[i]!.includes(MARKER_CLOSE)) lastClose = i;
  }
  if (lastOpen < 0 || lastClose <= lastOpen) return [];
  const out: string[] = [];
  let inSection = false;
  for (let i = lastOpen; i <= lastClose; i++) {
    const line = lines[i]!;
    if (line.startsWith("**Linked work items:**")) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^- (pr|issue) /.test(line)) {
      out.push(line);
      continue;
    }
    if (/^_None linked\._/.test(line)) continue;
    if (/^\s*$/.test(line)) continue;
    inSection = false;
  }
  return out;
}

/** Render a resolved link as a body entry: "- <kind> <display> — <title>". */
export function formatLinkEntry(r: LinkRefResolved): string {
  return `- ${r.kind} ${r.display} — ${r.title}`;
}
