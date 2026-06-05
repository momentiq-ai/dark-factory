// packages/cli/src/onboard/template-ref.ts
//
// Template-ref foundation (round-4 advisor restructure-completion).
//
// Co-located foundation file: both `scaffold-schema.ts` (Task 1) and
// `template-loader.ts` (Task 3) import `parseTemplateRef` from here so
// the predicate has a single source of truth (schema and loader cannot
// drift on the semantic ref check) AND there's no circular import (the
// loader can also import ScaffoldPlanSchema if it ever needs to without
// creating a cycle, because template-ref.ts imports from neither).
//
// History — round-3 W3 advisor restructure. Rounds 1+2 tried to encode
// the NEGATIVE constraint ("not a 7–39 hex string") as a POSITIVE
// character class inside a single regex. Each round's tweak introduced
// a new false-positive or false-negative: round 1 ([A-Za-z._/-]) silently
// accepted short hex; round 2 ([g-zG-Z._/-]) rejected valid pure-digit
// refs like `123456` / `20260603`; gemini's prescribed round-3 lookahead
// fix STILL rejected `20260603` (an 8-digit ref is a subset of
// [0-9a-fA-F]). The negative constraint cannot compose cleanly with a
// positive class. The restructure: narrow the regex to SHAPE, delegate
// semantics to this parser. See commit log + plan §B-D3 for the
// iteration arc (round-1 → round-2 → round-3 regex iteration; round-4
// shared-module extraction).

export const TEMPLATE_REF_SHAPE_RE = /^(gh:[^/]+\/[^@]+|file:\/\/\/[^@]+)@[^@]+$/;

export interface GhTemplateRef {
  kind: "gh";
  owner: string;
  repo: string;
  ref: string;
}

export interface FileTemplateRef {
  kind: "file";
  path: string;
  ref: string;
}

export type ParsedTemplateRef = GhTemplateRef | FileTemplateRef;

export function parseTemplateRef(input: string): ParsedTemplateRef {
  const fileMatch = input.match(/^file:\/\/(\/[^@]+)@([A-Za-z0-9._/-]+)$/);
  if (fileMatch) {
    return { kind: "file", path: fileMatch[1]!, ref: fileMatch[2]! };
  }
  const ghMatch = input.match(/^gh:([^/]+)\/([^@]+)@([A-Za-z0-9._/-]+)$/);
  if (ghMatch) {
    const [, owner, repo, ref] = ghMatch;
    if (
      ref!.length >= 7 &&
      ref!.length < 40 &&
      /^[0-9a-fA-F]+$/.test(ref!) &&
      /[a-fA-F]/.test(ref!)
    ) {
      throw new Error(
        `df onboard: short sha "${ref}" is not supported as a template ref. ` +
          "Use the full 40-character sha, or a tag/branch name.",
      );
    }
    return { kind: "gh", owner: owner!, repo: repo!, ref: ref! };
  }
  throw new Error(
    `df onboard: malformed templateRef "${input}". ` +
      "Expected gh:<owner>/<repo>@<ref> or file:///<abs-path>@<ref>.",
  );
}
