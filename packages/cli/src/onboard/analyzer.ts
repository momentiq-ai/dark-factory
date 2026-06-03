// Stage A analyzer interface — cycle 15 Phase A.
//
// Each domain analyzer (manifest, lockfile, ci, tree, git, docs) returns a
// Partial<RepoAnalysis>. The orchestrator merges every contribution and
// surfaces failures as a first-class schema field.
import type { RepoAnalysis, AnalyzerError } from "./schema.js";

export interface Analyzer {
  name: string;
  /**
   * Return `null` to opt out (e.g. no `package.json` → manifest analyzer's
   * JS branch skips). Return a `Partial<RepoAnalysis>` to contribute fields;
   * the orchestrator merges all contributions.
   */
  detect(rootDir: string): Promise<Partial<RepoAnalysis> | null>;
}

// `__analyzerErrors` is the INTERNAL merge field. The orchestrator surfaces
// it as the schema's `analyzerErrors` (see analyze.ts). The `__` prefix
// keeps it from escaping to validated output by accident.
export type MergedAnalysis = Partial<RepoAnalysis> & {
  __analyzerErrors?: AnalyzerError[];
};

export async function runAnalyzers(
  rootDir: string,
  analyzers: Analyzer[],
): Promise<MergedAnalysis> {
  const results = await Promise.all(
    analyzers.map(async (a) => {
      try {
        return {
          name: a.name,
          value: await a.detect(rootDir),
          error: null as string | null,
        };
      } catch (e) {
        return {
          name: a.name,
          value: null,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );

  const merged: MergedAnalysis = {};
  const errors: AnalyzerError[] = [];
  for (const r of results) {
    if (r.error !== null) {
      errors.push({ name: r.name, error: r.error });
      continue;
    }
    if (r.value === null) continue;
    mergeInto(merged, r.value);
  }
  if (errors.length > 0) merged.__analyzerErrors = errors;
  return merged;
}

function mergeInto(
  target: MergedAnalysis,
  source: Partial<RepoAnalysis>,
): void {
  for (const [key, value] of Object.entries(source) as [
    keyof RepoAnalysis,
    unknown,
  ][]) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const existing = (target[key] as unknown[] | undefined) ?? [];
      (target as Record<string, unknown>)[key] = [...existing, ...value];
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      const existing =
        (target[key] as Record<string, unknown> | undefined) ?? {};
      (target as Record<string, unknown>)[key] = { ...existing, ...value };
    } else {
      (target as Record<string, unknown>)[key] = value;
    }
  }
}
