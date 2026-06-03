// packages/cli/src/onboard/analyzers/manifest.ts
//
// Manifest analyzer — cycle 15 Phase A, Task 3.
//
// Detects every stack present in a repo from primary manifests (package.json,
// pyproject.toml, go.mod, Cargo.toml, Gemfile, mix.exs, pom.xml,
// build.gradle.kts), plus the asdf/mise multi-runtime `.tool-versions` file,
// plus a Dockerfile fallback signal. Populates `RepoAnalysis.stacks[]`.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "@iarna/toml";
import type { Analyzer } from "../analyzer.js";
import type { Stack } from "../schema.js";

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function detectNode(root: string): Promise<Stack | null> {
  const pkg = await readIfExists(join(root, "package.json"));
  if (!pkg) return null;
  let pin: string | null = null;
  try {
    const p = JSON.parse(pkg) as {
      engines?: { node?: string };
      volta?: { node?: string };
    };
    pin = p.engines?.node ?? p.volta?.node ?? null;
  } catch {
    /* malformed package.json — pin stays null */
  }
  if (!pin) {
    const nvmrc = await readIfExists(join(root, ".nvmrc"));
    if (nvmrc) pin = nvmrc.trim();
  }
  return { language: "typescript", versionPin: pin, manifestPath: "package.json" };
}

async function detectPython(root: string): Promise<Stack | null> {
  const py = await readIfExists(join(root, "pyproject.toml"));
  if (!py) return null;
  let pin: string | null = null;
  try {
    const parsed = parseToml(py) as {
      tool?: { poetry?: { dependencies?: { python?: string } } };
      project?: { "requires-python"?: string };
    };
    pin =
      parsed.tool?.poetry?.dependencies?.python ??
      parsed.project?.["requires-python"] ??
      null;
  } catch {
    /* malformed pyproject.toml — pin stays null */
  }
  if (!pin) {
    const pv = await readIfExists(join(root, ".python-version"));
    if (pv) pin = pv.trim() || null;
  }
  return { language: "python", versionPin: pin, manifestPath: "pyproject.toml" };
}

async function detectGo(root: string): Promise<Stack | null> {
  const body = await readIfExists(join(root, "go.mod"));
  if (!body) return null;
  const m = body.match(/^go\s+(\S+)/m);
  return {
    language: "go",
    versionPin: m?.[1] ?? null,
    manifestPath: "go.mod",
  };
}

async function detectRust(root: string): Promise<Stack | null> {
  const cargo = await readIfExists(join(root, "Cargo.toml"));
  if (!cargo) return null;
  let pin: string | null = null;
  try {
    const parsed = parseToml(cargo) as {
      package?: { "rust-version"?: string };
    };
    pin = parsed.package?.["rust-version"] ?? null;
  } catch {
    /* malformed Cargo.toml — pin stays null */
  }
  if (!pin) {
    const tc = await readIfExists(join(root, "rust-toolchain.toml"));
    if (tc) {
      try {
        const parsed = parseToml(tc) as {
          toolchain?: { channel?: string };
        };
        pin = parsed.toolchain?.channel ?? null;
      } catch {
        /* malformed rust-toolchain.toml — pin stays null */
      }
    }
  }
  return { language: "rust", versionPin: pin, manifestPath: "Cargo.toml" };
}

async function detectRuby(root: string): Promise<Stack | null> {
  const body = await readIfExists(join(root, "Gemfile"));
  if (!body) return null;
  const m = body.match(/^ruby\s+['"]([^'"]+)['"]/m);
  let pin: string | null = m?.[1] ?? null;
  if (!pin) {
    const rv = await readIfExists(join(root, ".ruby-version"));
    if (rv) pin = rv.trim() || null;
  }
  return { language: "ruby", versionPin: pin, manifestPath: "Gemfile" };
}

async function detectElixir(root: string): Promise<Stack | null> {
  const body = await readIfExists(join(root, "mix.exs"));
  if (!body) return null;
  const m = body.match(/elixir:\s*"([^"]+)"/);
  return {
    language: "elixir",
    versionPin: m?.[1] ?? null,
    manifestPath: "mix.exs",
  };
}

async function detectJava(root: string): Promise<Stack | null> {
  const body = await readIfExists(join(root, "pom.xml"));
  if (!body) return null;
  const compiler = body.match(
    /<maven\.compiler\.source>([^<]+)<\/maven\.compiler\.source>/,
  );
  const javaVer = body.match(/<java\.version>([^<]+)<\/java\.version>/);
  const pin = compiler?.[1] ?? javaVer?.[1] ?? null;
  return { language: "java", versionPin: pin, manifestPath: "pom.xml" };
}

async function detectKotlin(root: string): Promise<Stack | null> {
  const body = await readIfExists(join(root, "build.gradle.kts"));
  if (!body) return null;
  const jvm = body.match(/jvmTarget\s*=\s*"([^"]+)"/);
  let pin: string | null = jvm?.[1] ?? null;
  if (!pin) {
    const jv = body.match(/JavaVersion\.VERSION_(\d+)/);
    if (jv) pin = jv[1] ?? null;
  }
  return {
    language: "kotlin",
    versionPin: pin,
    manifestPath: "build.gradle.kts",
  };
}

async function detectDocker(root: string): Promise<Stack | null> {
  const body = await readIfExists(join(root, "Dockerfile"));
  if (!body) return null;
  const m = body.match(/^FROM\s+(\S+)/m);
  return {
    language: "other",
    versionPin: m?.[1] ?? null,
    manifestPath: "Dockerfile",
  };
}

const RUNTIME_TO_LANG: Record<string, Stack["language"]> = {
  nodejs: "typescript",
  node: "typescript",
  python: "python",
  golang: "go",
  go: "go",
  ruby: "ruby",
  rust: "rust",
  elixir: "elixir",
  java: "java",
  kotlin: "kotlin",
};

async function detectToolVersions(root: string): Promise<Stack[]> {
  const body = await readIfExists(join(root, ".tool-versions"));
  if (!body) return [];
  const out: Stack[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.split("#")[0]?.trim();
    if (!line) continue;
    const [rt, ver] = line.split(/\s+/);
    if (!rt || !ver) continue;
    const lang = RUNTIME_TO_LANG[rt.toLowerCase()];
    if (!lang) continue;
    out.push({ language: lang, versionPin: ver, manifestPath: ".tool-versions" });
  }
  return out;
}

// Merge a primary-manifest stack list with .tool-versions entries.
// Rule (see plan's "Supported manifests" table): .tool-versions pin wins for
// any language that also has a primary manifest, but the primary manifest's
// path is preserved as `manifestPath`. Languages only in .tool-versions are
// added with manifestPath: ".tool-versions". De-dupe by language.
function mergeStacks(primary: Stack[], toolVersions: Stack[]): Stack[] {
  const byLang = new Map<Stack["language"], Stack>();
  for (const s of primary) byLang.set(s.language, s);
  for (const tv of toolVersions) {
    const existing = byLang.get(tv.language);
    byLang.set(
      tv.language,
      existing ? { ...existing, versionPin: tv.versionPin } : tv,
    );
  }
  return [...byLang.values()];
}

export const manifestAnalyzer: Analyzer = {
  name: "manifest",
  async detect(rootDir) {
    const detectors = [
      detectNode,
      detectPython,
      detectGo,
      detectRust,
      detectRuby,
      detectElixir,
      detectJava,
      detectKotlin,
      detectDocker,
    ];
    const primary = (await Promise.all(detectors.map((d) => d(rootDir))))
      .filter((s): s is Stack => s !== null);
    const toolVersions = await detectToolVersions(rootDir);
    const stacks = mergeStacks(primary, toolVersions);
    if (stacks.length === 0) return null;
    return { stacks };
  },
};
