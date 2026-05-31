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

/**
 * Resolve a link ref to (kind, display, title) WITH a gh fetch.
 * PR-first per spec §3: a bare 42 is a PR if it resolves; else tried as an
 * issue. A `pr:N` / `issue:N` prefix short-circuits auto-detection.
 *
 * Throws HandoffError on:
 *   - project URL (deferred to Phase 12.2 per OQ-12.7)
 *   - invalid ref shape
 *   - ref 0 / leading-zero
 *   - both PR and issue lookups fail (not found)
 *   - resolved issue carries the handoff label (no link-cycles)
 */
export async function resolveLinkRef(
  input: string,
  gh: GhClient,
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
      // Refuse a handoff-labeled issue link target (no link-cycles).
      if (issue.labels.some((l) => l.name === HANDOFF_LABEL)) {
        throw new HandoffError(
          `refusing to link handoff issue ${display} (no link-cycles between handoff issues).`,
        );
      }
      title = issue.title;
      resolvedKind = "issue";
    } catch (err) {
      if (err instanceof HandoffError) throw err; // re-raise link-cycle refusal
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
