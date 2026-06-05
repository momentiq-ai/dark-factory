// packages/cli/src/onboard/auto-profile.ts
//
// Resolve the critic profile (local | cloud) from a RepoAnalysis when the
// operator did not pass --profile explicitly.
//
// This module is shipped as its own file (not inline in commands/onboard.ts)
// so Phase C's deterministic .agent-review/config.json seeder can import the
// same function via `import { autoProfile } from "../auto-profile.js"`. The
// single-source-of-truth keeps Phase B + Phase C aligned on the heuristic
// without either side re-implementing it.
//
// Heuristic (B-D8): a repo that already has a DF cli-pin AND a cloud PR
// workflow is one that already runs the cloud quartet — keep them on
// `cloud`. Everything else defaults to `local`. Explicit `--profile` always
// wins; this function is only the fallback.

import type { RepoAnalysis } from "./schema.js";

export function autoProfile(analysis: RepoAnalysis): "local" | "cloud" {
  const dfWired = analysis.dfPresence.cliPin !== null && analysis.dfPresence.prWorkflow;
  return dfWired ? "cloud" : "local";
}
