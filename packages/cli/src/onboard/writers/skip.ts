import type { SkipFilePlan } from "../scaffold-schema.js";

export interface SkipResult {
  path: string;
  action: "skip";
  rationale: string;
  wrote: false;
}

export async function writeSkip(_rootDir: string, plan: SkipFilePlan): Promise<SkipResult> {
  return {
    path: plan.path,
    action: "skip",
    rationale: plan.rationale,
    wrote: false,
  };
}
