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
      workflows: z.array(WorkflowSchema).max(20),
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
