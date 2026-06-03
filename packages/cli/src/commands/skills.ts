// `df skills install/list` — CLI surface for the bundled-skill installer.
//
// DFP #192: the OSS CLI owns the source-of-truth for skills that ship as
// part of the Dark Factory adoption (chief-engineer-review,
// chief-engineer-blitz, and any future ones). This subcommand renders the
// bundled skill templates against the consumer's `darkfactory.yaml` and
// writes the result to `.claude/skills/<name>/` in the consumer repo.
//
// Sub-subcommand pattern mirrors `df flow` — top-level `df skills` fans
// out to `install` / `list` inside cmdSkills rather than registering each
// at the top of cli.ts. Keeps the namespace grouped.
//
// CLI mirror of: `df_skills_install` + `df_skills_list` MCP tools (the
// same `installSkill` / `listBundledSkills` core powers both).

import {
  enabledSkillNames,
  loadDarkFactoryConfig,
} from "../skills/config.js";
import {
  installSkill,
  KNOWN_SKILLS,
  listBundledSkills,
  type InstallResult,
} from "../skills/install.js";

export interface SkillsIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const TOP_HELP = [
  "df skills — install consumer-shape templated skills bundled with @momentiq/dark-factory-cli.",
  "",
  "Usage:",
  "  df skills install <name>       Render + install one bundled skill.",
  "  df skills install --all        Install every skill declared `enabled: true`",
  "                                 in darkfactory.yaml.",
  "  df skills list                 List bundled skills + their summaries.",
  "  df skills --help, -h           Show this message.",
  "",
  "Install flags (df skills install):",
  "  --force                        Overwrite a hand-edited rendered file",
  "                                 (skipped by default — the renderer detects",
  "                                 the absence of the GENERATED marker).",
  "  --target-dir <path>            Override the install location",
  "                                 (default: <cwd>/.claude/skills/<name>/).",
  "  --json                         Print the install result as JSON.",
  "",
  "Bundled skills:",
  ...KNOWN_SKILLS.map((s) => `  - ${s}`),
  "",
  "Consumer config: place `darkfactory.yaml` at the repo root to override the",
  "rendered values (REPO_NAME, MANIFESTO_PATH, ADR_DIR, etc.). See the project",
  "README for the schema.",
  "",
].join("\n");

interface ParsedInstallArgs {
  readonly skillName?: string;
  readonly all: boolean;
  readonly force: boolean;
  readonly json: boolean;
  readonly targetDir?: string;
}

function parseInstallArgs(rest: string[]): ParsedInstallArgs | { error: string } {
  let skillName: string | undefined;
  let all = false;
  let force = false;
  let json = false;
  let targetDir: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a === "--all") {
      all = true;
      continue;
    }
    if (a === "--force") {
      force = true;
      continue;
    }
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--target-dir") {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { error: "--target-dir requires a value." };
      }
      targetDir = next;
      i++;
      continue;
    }
    if (a.startsWith("--target-dir=")) {
      targetDir = a.slice("--target-dir=".length);
      continue;
    }
    if (a.startsWith("--")) {
      return { error: `unknown flag: ${a}` };
    }
    if (skillName === undefined) {
      skillName = a;
      continue;
    }
    return { error: `unexpected positional arg: ${a}` };
  }
  if (!all && skillName === undefined) {
    return { error: "missing skill name (or --all). Run `df skills --help`." };
  }
  if (all && skillName !== undefined) {
    return { error: "cannot pass both <name> and --all." };
  }
  const out: ParsedInstallArgs = {
    all,
    force,
    json,
    ...(skillName !== undefined ? { skillName } : {}),
    ...(targetDir !== undefined ? { targetDir } : {}),
  };
  return out;
}

function renderInstallTextSummary(r: InstallResult): string {
  const lines: string[] = [];
  lines.push(
    `df skills install: ${r.skillName} v${r.manifestVersion} → ${r.files.length} file(s) processed`,
  );
  lines.push(
    `  config: ${r.configPath}${r.configIsDefault ? " (defaults — no darkfactory.yaml present)" : ""}`,
  );
  for (const f of r.files) {
    if (f.action === "skipped") {
      lines.push(`  ! ${f.relTarget} — SKIPPED (${f.reason ?? "skipped"})`);
    } else {
      lines.push(`  - ${f.relTarget} — ${f.action}`);
    }
  }
  if (r.resolvedVariables.length > 0) {
    lines.push(`  variables resolved:`);
    for (const v of r.resolvedVariables) {
      // Truncate multi-line list values to first line + ellipsis for the
      // text summary — full values are visible in --json.
      const oneLine = v.value.includes("\n")
        ? `${v.value.split("\n")[0]} … (${v.value.split("\n").length} lines)`
        : v.value;
      lines.push(`    {{${v.name}}} = ${oneLine}`);
    }
  }
  return lines.join("\n");
}

async function cmdSkillsInstall(rest: string[], io: SkillsIo): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    io.stdout(TOP_HELP);
    return 0;
  }
  const parsed = parseInstallArgs(rest);
  if ("error" in parsed) {
    io.stderr(`df skills install: ${parsed.error}\n`);
    return 2;
  }
  const cwd = process.cwd();
  let targetSkills: string[];
  if (parsed.all) {
    // Reject --all + --target-dir at the CLI surface: every bundled skill
    // targets SKILL.md, so a shared target-dir would have the second install
    // overwrite the first. Surface a clear error so the consumer either drops
    // --target-dir (gets the default per-skill .claude/skills/<name>/) or
    // splits the invocations one-skill-at-a-time.
    if (parsed.targetDir !== undefined) {
      io.stderr(
        `df skills install: --all is incompatible with --target-dir (bundled skills share target filenames like SKILL.md, so a single dir would overwrite). Install each skill separately, or omit --target-dir to use the default <cwd>/.claude/skills/<name>/.\n`,
      );
      return 2;
    }
    const loaded = loadDarkFactoryConfig(cwd);
    const enabled = enabledSkillNames(loaded.config);
    if (enabled.length === 0) {
      io.stderr(
        `df skills install: --all found no skills marked enabled: true in ${loaded.configPath} (${loaded.isDefault ? "no darkfactory.yaml present" : "present"}).\n`,
      );
      return 1;
    }
    const unknown = enabled.filter((name) => !KNOWN_SKILLS.includes(name));
    if (unknown.length > 0) {
      io.stderr(
        `df skills install: --all rejected — unknown skill name(s) in ${loaded.configPath}: ${unknown.join(", ")}. Known skills: ${KNOWN_SKILLS.join(", ")}.\n`,
      );
      return 2;
    }
    targetSkills = enabled;
  } else if (parsed.skillName !== undefined) {
    targetSkills = [parsed.skillName];
  } else {
    // Shouldn't be reachable — parseInstallArgs guards.
    io.stderr(`df skills install: no skill named.\n`);
    return 2;
  }

  const results: InstallResult[] = [];
  let exitCode = 0;
  for (const name of targetSkills) {
    try {
      const opts: Parameters<typeof installSkill>[0] = {
        cwd,
        skillName: name,
        force: parsed.force,
        ...(parsed.targetDir !== undefined ? { targetDir: parsed.targetDir } : {}),
      };
      const r = installSkill(opts);
      results.push(r);
      // Non-fatal but worth surfacing: if any file was skipped (hand-edited
      // without --force), exit code 3 so CI catches the partial install.
      if (r.files.some((f) => f.action === "skipped")) {
        exitCode = Math.max(exitCode, 3);
      }
    } catch (err) {
      io.stderr(`df skills install: ${(err as Error).message}\n`);
      return 1;
    }
  }

  if (parsed.json) {
    io.stdout(`${JSON.stringify({ installed: results }, null, 2)}\n`);
  } else {
    for (const r of results) {
      io.stdout(`${renderInstallTextSummary(r)}\n`);
    }
    if (exitCode === 3) {
      io.stdout(
        `\nNote: one or more files were skipped because they were hand-edited. Re-run with --force to overwrite.\n`,
      );
    }
  }
  return exitCode;
}

function cmdSkillsList(rest: string[], io: SkillsIo): number {
  if (rest.includes("--help") || rest.includes("-h")) {
    io.stdout(TOP_HELP);
    return 0;
  }
  const json = rest.includes("--json");
  const items = listBundledSkills();
  if (json) {
    io.stdout(`${JSON.stringify({ skills: items }, null, 2)}\n`);
    return 0;
  }
  if (items.length === 0) {
    io.stdout(`df skills list: no bundled skills.\n`);
    return 0;
  }
  io.stdout(`df skills list — ${items.length} bundled skill(s)\n`);
  for (const item of items) {
    io.stdout(`\n  ${item.name} (v${item.version})`);
    if (item.originatingRepo) io.stdout(`  origin: ${item.originatingRepo}`);
    io.stdout(`\n    ${item.summary}\n`);
  }
  return 0;
}

export async function cmdSkills(rest: string[]): Promise<number> {
  const io: SkillsIo = {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  };
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    io.stdout(TOP_HELP);
    return 0;
  }
  const sub = rest[0];
  const subRest = rest.slice(1);
  if (sub === "install") {
    return await cmdSkillsInstall(subRest, io);
  }
  if (sub === "list") {
    return cmdSkillsList(subRest, io);
  }
  io.stderr(`df skills: unknown subcommand "${sub}". Run \`df skills --help\`.\n`);
  return 2;
}
