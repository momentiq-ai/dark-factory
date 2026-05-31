// packages/cli/src/handoff/rehydrate-core.ts
//
// Pure-data core of /rehydrate. PORT FROM dark-factory-platform
// .claude/skills/handoff/scripts/lib.sh@a6f711b lines 427-598
// (do_rehydrate + _derive_linked_item), but RESHAPED per advisor:
//   bash: interleaves gh calls + printf (output IS the data)
//   TS:   gh calls only, returns a structured RehydrateData object
//
// Three consumers will compose this differently (no text duplication):
//   - accept-verb.ts (Task 12)    — strict mode: throws if linkFailures > 0
//   - rehydrate-verb.ts (Task 13) — lenient: returns data unconditionally
//   - mcp/tools/handoff.ts (Task 24) — returns the object as structuredContent
//
// CLI text rendering lives in rehydrate-render.ts (Task 10), keyed off
// this object. The Task 21 parity tests assert byte-identical bash output
// from the rendered text; the verb tests (Tasks 17-20) assert on the
// structured fields.
//
// Bash-parity notes (silent-divergence traps that bite later if missed):
//   - summarizeChecks SORTS buckets ascending (jq `group_by(.)`); Map
//     insertion order would diverge whenever a PR has ≥2 distinct check
//     conclusions.
//   - `note` is RAW (markers + control chars intact). Render is responsible
//     for stripping. `title` is stripped here, matching the bash which
//     strips title before printing but emits the note block raw and then
//     pipes it through `strip_control_chars` at print time.
//   - Linked items are processed SEQUENTIALLY (`for...of` with await).
//     Bash is sequential; concurrent fetches would scramble the call
//     ordinals the FakeGhClient slots depend on.
//   - `linkFailures` is derived from `linkedItems` (filter on state ===
//     "UNREACHABLE") so it cannot drift from the array.

import { extractLinkedItems } from "./links.js";
import { MARKER_OPEN, MARKER_CLOSE } from "./markers.js";
import { HandoffError, type GhClient, type PrView } from "./ports.js";
import { stripControlChars } from "./strip-control.js";

export interface LinkedItemDerivation {
  readonly kind: "pr" | "issue" | "?";
  readonly display: string;
  readonly title: string;
  readonly state: "OPEN" | "CLOSED" | "MERGED" | "UNREACHABLE";
  /** Human annotation: "", "(merged)", "(closed)",
   * "(unreachable: gh pr view failed)" / "(unreachable: gh issue view failed)",
   * "[open]", "[open, assigned X]", "(unknown link type)". */
  readonly annotation: string;
  /** Present for OPEN PRs only — copy-pastable `gh pr checkout N [--repo owner/repo]`. */
  readonly checkoutHint?: string;
  /** Extra fields for OPEN PRs (mergeStateStatus/reviewDecision/checksSummary)
   * or OPEN issues (assigneesCsv). Absent for MERGED/CLOSED/UNREACHABLE. */
  readonly extra?: {
    readonly mergeStateStatus?: string;
    readonly reviewDecision?: string;
    readonly checksSummary?: string;
    readonly assigneesCsv?: string;
  };
}

export interface RehydrateData {
  readonly issueNumber: number;
  /** Stripped of control chars (operator-editable title — ANSI defense). */
  readonly title: string;
  /** Value only — render adds the `state: ` prefix and indentation.
   * One of:
   *   "open (unassigned — on the stack)"
   *   "open (assigned X[,Y...])"
   *   "closed (accepted YYYY-MM-DD)"
   *   "closed"
   */
  readonly stateLine: string;
  readonly linkedItems: readonly LinkedItemDerivation[];
  /** Count of items with state === "UNREACHABLE" (strict-mode trigger). */
  readonly linkFailures: number;
  /** Last marker block from `view.body`, INCLUDING the marker tokens.
   * `null` if no well-formed block found. Control chars NOT yet stripped —
   * the renderer strips them at print time (matches bash). */
  readonly note: string | null;
}

/**
 * Aggregate a statusCheckRollup into "N pass, M fail" style rendering.
 * Buckets are SORTED ASCENDING by name to match the bash's `jq group_by(.)`
 * — otherwise Map insertion order silently diverges from bash output on
 * multi-bucket rollups (caught by Task 21 parity snapshot).
 */
function summarizeChecks(rollup: PrView["statusCheckRollup"]): string {
  if (rollup.length === 0) return "no checks";
  const buckets = new Map<string, number>();
  for (const c of rollup) {
    const key = (c.conclusion ?? c.state ?? "UNKNOWN").toLowerCase();
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return Array.from(buckets.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
}

/** Extract the LAST marker block (including marker tokens) from body, or null. */
function lastMarkerBlock(body: string): string | null {
  const lines = body.split("\n");
  let lastOpen = -1;
  let lastClose = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(MARKER_OPEN)) lastOpen = i;
    if (lines[i]!.includes(MARKER_CLOSE)) lastClose = i;
  }
  if (lastOpen < 0 || lastClose <= lastOpen) return null;
  return lines.slice(lastOpen, lastClose + 1).join("\n");
}

/** Parse a body entry `- (pr|issue) <ref> — <title>` into kind/display/title.
 * Returns null on malformed input. */
function parseEntry(
  line: string,
): { kind: "pr" | "issue"; display: string; title: string } | null {
  // Bash regex: `^- (pr|issue) (\S+) — (.+)$` (em dash separator).
  const m = line.match(/^- (pr|issue) (\S+) — (.+)$/);
  if (!m) return null;
  return { kind: m[1] as "pr" | "issue", display: m[2]!, title: m[3]! };
}

/** Split a display ref ("#N" or "owner/repo#N") into (ownerRepo, num). */
function splitDisplay(display: string): { ownerRepo: string; num: number } {
  let ownerRepo = "";
  let numStr = display;
  if (display.startsWith("#")) {
    numStr = display.slice(1);
  } else if (display.includes("#")) {
    const idx = display.indexOf("#");
    ownerRepo = display.slice(0, idx);
    numStr = display.slice(idx + 1);
  }
  return { ownerRepo, num: Number(numStr) };
}

/** Derive live state for one parsed entry. Sequential w.r.t. callers. */
async function deriveLinkedItem(
  parsed: { kind: "pr" | "issue"; display: string; title: string },
  gh: GhClient,
): Promise<LinkedItemDerivation> {
  const title = stripControlChars(parsed.title);
  const { ownerRepo, num } = splitDisplay(parsed.display);
  const opts = ownerRepo ? { repo: ownerRepo } : undefined;

  if (parsed.kind === "pr") {
    let pr: PrView;
    try {
      pr = opts ? await gh.prView(num, opts) : await gh.prView(num);
    } catch {
      return {
        kind: "pr",
        display: parsed.display,
        title,
        state: "UNREACHABLE",
        annotation: "(unreachable: gh pr view failed)",
      };
    }
    if (pr.state === "MERGED") {
      return {
        kind: "pr",
        display: parsed.display,
        title,
        state: "MERGED",
        annotation: "(merged)",
      };
    }
    if (pr.state === "CLOSED") {
      return {
        kind: "pr",
        display: parsed.display,
        title,
        state: "CLOSED",
        annotation: "(closed)",
      };
    }
    // OPEN — emit checkoutHint + extra.
    return {
      kind: "pr",
      display: parsed.display,
      title,
      state: "OPEN",
      annotation: "",
      checkoutHint: ownerRepo
        ? `gh pr checkout ${num} --repo ${ownerRepo}`
        : `gh pr checkout ${num}`,
      extra: {
        mergeStateStatus: pr.mergeStateStatus,
        reviewDecision: pr.reviewDecision,
        checksSummary: summarizeChecks(pr.statusCheckRollup),
      },
    };
  }

  // kind === "issue"
  try {
    const iss = opts ? await gh.issueView(num, opts) : await gh.issueView(num);
    if (iss.state === "CLOSED") {
      return {
        kind: "issue",
        display: parsed.display,
        title,
        state: "CLOSED",
        annotation: "(closed)",
      };
    }
    const assigneesCsv = iss.assignees.map((a) => a.login).join(",");
    return {
      kind: "issue",
      display: parsed.display,
      title,
      state: "OPEN",
      annotation: assigneesCsv ? `[open, assigned ${assigneesCsv}]` : "[open]",
      extra: { assigneesCsv },
    };
  } catch {
    return {
      kind: "issue",
      display: parsed.display,
      title,
      state: "UNREACHABLE",
      annotation: "(unreachable: gh issue view failed)",
    };
  }
}

/**
 * Derive structured live state for handoff issue #N. Used by /accept (strict),
 * /rehydrate (lenient), and df_rehydrate (MCP structuredContent).
 *
 * Linked items are processed SEQUENTIALLY (bash parity + FakeGhClient ordinal
 * slot stability). The MAIN issue is the FIRST `issueView` call; any linked
 * issues that follow share that counter, so test slots are 1 = handoff, 2+ =
 * linked issues.
 *
 * @throws HandoffError if `gh.issueView(issueNum)` fails — the live-state
 *   anchor is required; don't proceed on the note alone.
 */
export async function deriveRehydrateData(
  issueNum: number,
  gh: GhClient,
): Promise<RehydrateData> {
  let view;
  try {
    view = await gh.issueView(issueNum);
  } catch {
    throw new HandoffError(
      `could not derive live state for #${issueNum} (gh issue view failed) — ` +
        "fix gh/network and retry; do not proceed on the note alone.",
    );
  }

  const title = stripControlChars(view.title);

  let stateLine: string;
  if (view.state === "CLOSED") {
    if (view.closedAt) {
      stateLine = `closed (accepted ${view.closedAt.slice(0, 10)})`;
    } else {
      stateLine = "closed";
    }
  } else {
    const assigneesCsv = view.assignees.map((a) => a.login).join(",");
    stateLine = assigneesCsv
      ? `open (assigned ${assigneesCsv})`
      : "open (unassigned — on the stack)";
  }

  const linkedItems: LinkedItemDerivation[] = [];
  const entries = extractLinkedItems(view.body);
  for (const line of entries) {
    const parsed = parseEntry(line);
    if (!parsed) {
      linkedItems.push({
        kind: "?",
        display: line,
        title: "",
        state: "UNREACHABLE",
        annotation: "(unknown link type)",
      });
      continue;
    }
    linkedItems.push(await deriveLinkedItem(parsed, gh));
  }

  const linkFailures = linkedItems.filter(
    (i) => i.state === "UNREACHABLE",
  ).length;

  const note = lastMarkerBlock(view.body);

  return {
    issueNumber: issueNum,
    title,
    stateLine,
    linkedItems,
    linkFailures,
    note,
  };
}
