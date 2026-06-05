// packages/cli/src/onboard/writers/emit.ts
import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { EmitFilePlan } from "../scaffold-schema.js";

export interface EmitOptions {
  force?: boolean;
}

function safeResolve(root: string, p: string): string {
  if (isAbsolute(p)) {
    throw new Error(`df onboard: refuses to emit to absolute path "${p}" (outside the target root).`);
  }
  const resolved = resolve(root, p);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`df onboard: path traversal blocked — "${p}" resolves outside the target root.`);
  }
  return resolved;
}

export async function writeEmit(
  rootDir: string,
  plan: EmitFilePlan,
  opts: EmitOptions = {},
): Promise<void> {
  const abs = safeResolve(rootDir, plan.path);
  let exists = false;
  try { await stat(abs); exists = true; } catch {}
  if (exists && !opts.force) {
    throw new Error(
      `df onboard: refuses to overwrite existing file "${plan.path}" (pass force=true to override).`,
    );
  }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, plan.tailored_content, "utf8");
}
