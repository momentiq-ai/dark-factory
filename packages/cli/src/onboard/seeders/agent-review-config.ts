// packages/cli/src/onboard/seeders/agent-review-config.ts
//
// 4th Phase C deterministic seeder. Owns the emission of
// `.agent-review/config.json` as a `FilePlan` entry. Per the cross-phase
// contract (Phase C plan Task 3.6 / Phase B PR #134 reconciliation),
// Phase B's LLM scaffold SKIPS this path unconditionally; this seeder is
// the single producer.
//
// The canonical JSON bodies live as production files under
// `./agent-review-config/{local,cloud}.canonical.json` — they ship inside
// the published npm package (covered by packages/cli/package.json's
// `files: ["src/**", ...]` entry). The seeder readFile's them at runtime;
// the test `readFile`s the same production path so tests reference what
// actually ships. One source of truth per profile.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { FilePlan } from "../scaffold-schema.js";
import type { Seeder, SeederInput } from "./index.js";

const CANONICAL_DIR = join(dirname(fileURLToPath(import.meta.url)), "agent-review-config");

async function loadCanonical(profile: "local" | "cloud"): Promise<string> {
  return readFile(join(CANONICAL_DIR, `${profile}.canonical.json`), "utf8");
}

export const agentReviewConfigSeeder: Seeder = {
  name: "agent-review-config",
  async seed(input: SeederInput): Promise<FilePlan[]> {
    const profile = input.profile ?? "local";
    const body = await loadCanonical(profile);
    return [
      {
        path: ".agent-review/config.json",
        action: "emit",
        rationale:
          `agent-review config emitted for profile=${profile} (cycle 15 D3 row 5 / D7). ` +
          `Phase C deterministic seeder; Phase B does NOT emit this path (cross-phase contract).`,
        tailored_content: body,
      },
    ];
  },
};
