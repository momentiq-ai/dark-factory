// packages/cli/src/onboard/prompts.ts
//
// Render the Stage B scaffold prompt by substituting the analysis + template
// into the static prompt asset. The asset path uses import.meta.url so the
// resolution works both from src/ (dev) and dist/ (npm install), matching
// the project's existing pattern in critic prompts.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RepoAnalysis } from "./schema.js";
import type { TemplateFile } from "./template-loader.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSET_PATH = join(HERE, "prompts", "scaffold.md");

let _cachedAsset: string | null = null;
async function loadAsset(): Promise<string> {
  if (_cachedAsset !== null) return _cachedAsset;
  _cachedAsset = await readFile(ASSET_PATH, "utf8");
  return _cachedAsset;
}

export interface RenderedPrompt {
  systemPrompt: string;
  userMessage: string;
}

export interface RenderScaffoldPromptOptions {
  /** Resolved critic profile (B-D8). Substituted into the system prompt's `{{CRITIC_PROFILE}}` placeholder so the LLM's `.agent-review/config.json` tailoring uses the right fleet. */
  profile: "local" | "cloud";
}

function renderFileList(files: TemplateFile[]): string {
  return files
    .map((f) => `- ${f.path} (${Buffer.byteLength(f.content, "utf8")} bytes)`)
    .join("\n");
}

function renderFileBodies(files: TemplateFile[]): string {
  return files
    .map((f) => `path: ${f.path}\n---\n${f.content}\n===\n`)
    .join("\n");
}

export function renderScaffoldPromptSync(
  asset: string,
  analysis: RepoAnalysis,
  templateFiles: TemplateFile[],
  opts: RenderScaffoldPromptOptions,
): RenderedPrompt {
  // Split the asset on a marker so the operating contract is the SYSTEM prompt
  // (cached, prompt-cached on the SDK side) and the per-call payload is the
  // USER message. The marker is the "## Inputs" heading.
  const splitIdx = asset.indexOf("## Inputs");
  if (splitIdx < 0) {
    throw new Error(
      "df onboard: scaffold.md asset missing '## Inputs' split marker — prompt-asset corruption.",
    );
  }
  // {{CRITIC_PROFILE}} appears in both halves (rule 4a in the system prompt;
  // the verbatim profile echo in the user payload), so replaceAll both sides.
  const systemPrompt = asset.slice(0, splitIdx)
    .replaceAll("{{CRITIC_PROFILE}}", opts.profile)
    .trim();
  const userTemplate = asset.slice(splitIdx);
  const userMessage = userTemplate
    .replaceAll("{{CRITIC_PROFILE}}", opts.profile)
    .replace("{{ANALYSIS_JSON}}", JSON.stringify(analysis, null, 2))
    .replace("{{TEMPLATE_FILE_LIST}}", renderFileList(templateFiles))
    .replace("{{TEMPLATE_FILE_BODIES}}", renderFileBodies(templateFiles));
  return { systemPrompt, userMessage };
}

export async function renderScaffoldPrompt(
  analysis: RepoAnalysis,
  templateFiles: TemplateFile[],
  opts: RenderScaffoldPromptOptions,
): Promise<RenderedPrompt> {
  const asset = await loadAsset();
  return renderScaffoldPromptSync(asset, analysis, templateFiles, opts);
}
