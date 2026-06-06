// RepoAnalysis schema — cycle 15 Phase A.
//
// Bounded, schema-versioned envelope produced by the deterministic Stage A
// scanner. Phase B's LLM consumes this verbatim; the 16 KB serialized-size
// budget (enforced in analyze.ts) plus per-array .max() caps keep the
// envelope small enough to fit in a single LLM call's context.
import { z } from "zod";

export const AGENT_CONTEXT_SCHEMA_VERSION = 1 as const;

const StackSchema = z.object({
  language: z.enum([
    "typescript",
    "javascript",
    "python",
    "go",
    "rust",
    "ruby",
    "elixir",
    "java",
    "kotlin",
    "csharp",
    "swift",
    "other",
  ]),
  versionPin: z.string().nullable(),
  manifestPath: z.string(),
});

const ServiceSchema = z.object({
  name: z.string(),
  path: z.string(),
  stack: z.string().nullable(),
});

const WorkflowSchema = z.object({
  name: z.string(),
  path: z.string(),
  triggers: z.array(z.string()),
  jobs: z.array(z.string()),
  matrixDimensions: z.array(z.string()),
  // First non-trivial single-line `run:` command in the workflow (>10 chars,
  // not a YAML block scalar marker like `|`/`>`). null when the workflow
  // has only multi-line `run: |` blocks or `uses:`-only steps. Consumed by
  // the runbook seeder's donor fallback (issue #138): on repos whose
  // deploy-named workflows have no single-line `run:`, the seeder appends
  // the first non-deploy-named workflow with a `firstRunCommand` so Phase C
  // metric 4 ("runbook contains verbatim CI run: line") stays satisfiable.
  // The validator's metric-4 candidate-line regex matches the same shape;
  // capturing via parsed-YAML would silently lose the single-vs-multiline
  // distinction (raw-text extraction is intentional — see ci.ts).
  firstRunCommand: z.string().nullable(),
});

const DeployStorySchema = z.object({
  workflowPath: z.string(),
  command: z.string(),
  target: z.enum([
    "helm",
    "gh-release",
    "gcloud-run",
    "ecs",
    "vercel",
    "fly",
    "kubernetes",
    "other",
  ]),
});

const TopLevelDirSchema = z.object({
  name: z.string(),
  category: z.enum([
    "services",
    "apps",
    "packages",
    "src",
    "tests",
    "docs",
    "infra",
    "scripts",
    "other",
  ]),
  fileCount: z.number().int().nonnegative(),
});

const DecisionSchema = z.object({
  title: z.string(),
  surface: z.enum([
    "stack",
    "test-framework",
    "deploy-target",
    "auth-model",
    "ci-platform",
    "other",
  ]),
  evidence: z.array(z.string()),
});

// Per cycle 15 D2 lines 142–145: when CLAUDE.md / AGENTS.md exists, capture
// only sizeBytes + the ordered H1+H2 heading list (cap 50). Bodies are NEVER
// stored — Phase B reads them itself if it needs them.
const AgentFileSchema = z.object({
  sizeBytes: z.number().int().nonnegative(),
  headings: z.array(z.string()).max(50),
});

// Per cycle 15 D2 lines 132–134: capture exact versions of the top 20
// dependencies for the ADR seed. `decisions[]` is the heuristic narrative;
// `dependencies[]` is the deterministic name+version table the LLM cites.
const DependencySchema = z.object({
  name: z.string(),
  version: z.string(),
  manifestPath: z.string(),
});

const AnalyzerErrorSchema = z.object({
  name: z.string(),
  error: z.string(),
});

export const RepoAnalysisSchema = z
  .object({
    schemaVersion: z.literal(AGENT_CONTEXT_SCHEMA_VERSION),
    repoRoot: z.string(),
    canonicalName: z.string(),
    stacks: z.array(StackSchema).max(12),
    services: z.array(ServiceSchema).max(30),
    dependencies: z.array(DependencySchema).max(20),
    ci: z.object({
      // Bumped 20 → 50 in cycle 15 Phase C to admit sage3c (28 workflows)
      // through the schema; the 16 KB byte-budget canary on
      // `RepoAnalysis` JSON still gates the absolute output size. Workflow
      // entries are small (name + path + jobs + triggers), so 50 fits well
      // inside the budget; the previous 20-cap was an aggressive heuristic
      // that the sage3c reproduction harness empirically outgrew.
      workflows: z.array(WorkflowSchema).max(50),
      deployStory: DeployStorySchema.nullable(),
    }),
    tree: z.object({
      topLevelDirs: z.array(TopLevelDirSchema).max(30),
      languageBreakdown: z.record(z.string(), z.number().int().nonnegative()),
      testDirs: z.array(z.string()).max(20),
      fileCount: z.number().int().nonnegative(),
    }),
    git: z.object({
      recentCommitConventions: z.object({
        conventional: z.boolean(),
        cycleReferenced: z.boolean(),
      }),
      defaultBranch: z.string(),
    }),
    docs: z.object({
      existing: z.array(z.string()).max(50),
      hasClaudeMd: z.boolean(),
      hasAgentsMd: z.boolean(),
      agentContextSetPresent: z.boolean(),
      claudeMd: AgentFileSchema.nullable(),
      agentsMd: AgentFileSchema.nullable(),
    }),
    dfPresence: z.object({
      hooks: z.boolean(),
      configJson: z.boolean(),
      prWorkflow: z.boolean(),
      cliPin: z.string().nullable(),
    }),
    // Heuristic decision-surface markers (test-framework / deploy-target /
    // stack / auth-model) aggregated across ALL lockfiles in the repo, not
    // just the root one (see analyzers/lockfile.ts and #137 for the monorepo
    // motivation). Deduped on the `(title, surface)` tuple; each entry's
    // `evidence[]` is the sorted union of source lockfile paths.
    decisions: z.array(DecisionSchema).max(10),
    analyzerErrors: z.array(AnalyzerErrorSchema).default([]),
  })
  .strict();

export type RepoAnalysis = z.infer<typeof RepoAnalysisSchema>;
export type Stack = z.infer<typeof StackSchema>;
export type Service = z.infer<typeof ServiceSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type DeployStory = z.infer<typeof DeployStorySchema>;
export type TopLevelDir = z.infer<typeof TopLevelDirSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type Dependency = z.infer<typeof DependencySchema>;
export type AgentFile = z.infer<typeof AgentFileSchema>;
export type AnalyzerError = z.infer<typeof AnalyzerErrorSchema>;
