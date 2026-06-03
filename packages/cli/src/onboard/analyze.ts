// analyze() orchestrator — cycle 15 Phase A.
//
// Pulls the 6 domain analyzers together, surfaces failures as a first-class
// `analyzerErrors` field (never silently dropped), enforces the 16 KB
// serialized-size budget as a final backstop, returns a Zod-validated
// RepoAnalysis.
import { runAnalyzers, type Analyzer } from "./analyzer.js";
import {
  RepoAnalysisSchema,
  type RepoAnalysis,
  AGENT_CONTEXT_SCHEMA_VERSION,
} from "./schema.js";
import { manifestAnalyzer } from "./analyzers/manifest.js";
import { lockfileAnalyzer } from "./analyzers/lockfile.js";
import { ciAnalyzer } from "./analyzers/ci.js";
import { treeAnalyzer } from "./analyzers/tree.js";
import { gitAnalyzer } from "./analyzers/git.js";
import { docsAnalyzer } from "./analyzers/docs.js";

const ALL_ANALYZERS = [
  manifestAnalyzer,
  lockfileAnalyzer,
  ciAnalyzer,
  treeAnalyzer,
  gitAnalyzer,
  docsAnalyzer,
];

// The 16 KB serialized-size budget is a hard contract (cycle 15 D2 line 154,
// exit criterion "RepoAnalysis JSON of bounded size (≤ 16 KB)"). The per-array
// .max() caps on the Zod schema prevent the common overflow paths; this final
// enforcement is the backstop for unforeseen growth (giant headings, very long
// canonicalName, etc.) so a partial silent-truncation can never reach Phase B.
export const REPO_ANALYSIS_BYTE_BUDGET = 16_384;

function emptyBase(rootDir: string): RepoAnalysis {
  return {
    schemaVersion: AGENT_CONTEXT_SCHEMA_VERSION,
    repoRoot: rootDir,
    canonicalName: "",
    stacks: [],
    services: [],
    dependencies: [],
    ci: { workflows: [], deployStory: null },
    tree: { topLevelDirs: [], languageBreakdown: {}, testDirs: [], fileCount: 0 },
    git: {
      recentCommitConventions: { conventional: false, cycleReferenced: false },
      defaultBranch: "main",
    },
    docs: {
      existing: [],
      hasClaudeMd: false,
      hasAgentsMd: false,
      agentContextSetPresent: false,
      claudeMd: null,
      agentsMd: null,
    },
    dfPresence: { hooks: false, configJson: false, prWorkflow: false, cliPin: null },
    decisions: [],
    analyzerErrors: [],
  };
}

export async function analyze(
  rootDir: string,
  analyzers: Analyzer[] = ALL_ANALYZERS,
): Promise<RepoAnalysis> {
  const merged = await runAnalyzers(rootDir, analyzers);
  // Surface analyzer failures as a first-class schema field; never drop them.
  // The orchestrator does NOT throw on per-analyzer errors — partial-result
  // reporting is the contract — but the field's presence is the loud signal
  // Phase B and CLI consumers branch on.
  const { __analyzerErrors, ...rest } = merged;
  const base = emptyBase(rootDir);
  const combined: RepoAnalysis = {
    ...base,
    ...rest,
    // Each top-level object field needs explicit merge so partial analyzers
    // don't blow away the defaults from emptyBase.
    ci: { ...base.ci, ...(rest.ci ?? {}) },
    tree: { ...base.tree, ...(rest.tree ?? {}) },
    git: { ...base.git, ...(rest.git ?? {}) },
    docs: { ...base.docs, ...(rest.docs ?? {}) },
    dfPresence: { ...base.dfPresence, ...(rest.dfPresence ?? {}) },
    analyzerErrors: __analyzerErrors ?? [],
  };
  const parsed = RepoAnalysisSchema.parse(combined);
  const json = JSON.stringify(parsed);
  if (json.length > REPO_ANALYSIS_BYTE_BUDGET) {
    throw new Error(
      `RepoAnalysis exceeds ${REPO_ANALYSIS_BYTE_BUDGET}-byte budget: produced ${json.length} bytes. ` +
        "Likely cause: oversized headings/decisions/dependencies; rerun against a bounded subset or " +
        "tighten analyzer caps. (cycle 15 D2 / exit criterion)",
    );
  }
  return parsed;
}

export { ALL_ANALYZERS };
