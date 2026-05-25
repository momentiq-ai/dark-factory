// Doppler bootstrap loader for the OSS CLI.
//
// Cycle 331.1 Phase F-LOCAL — ported from sage3c's
// tools/agent-review/src/doppler-bootstrap.ts (cycle 318.3 / #1312) with
// two genericizing changes:
//
//   1. The `DOPPLER_SERVICE_TOKEN_SAGE` key is a sage3c convention. The OSS
//      default allowlist is just `["DOPPLER_TOKEN"]`. Consumers that use
//      Doppler service tokens with project-scoped names pass their own
//      allowlist via `loadDopplerBootstrapEnv({ allowlist: ... })`.
//
//   2. The "map service token → DOPPLER_TOKEN" auto-bridge (sage's
//      `DOPPLER_SERVICE_TOKEN_SAGE` was bridged to `DOPPLER_TOKEN`) is now
//      a generic option: `serviceTokenAlias`. When set, the loader copies
//      the named key's value into `DOPPLER_TOKEN` if the latter is unset.
//      Sage3c (and any other consumer with a project-scoped service token
//      var) sets `serviceTokenAlias: "DOPPLER_SERVICE_TOKEN_SAGE"`.
//
// Why this loader exists (recap of the sage3c constraint):
//
//   Husky hooks run inside a fresh-shell environment that does NOT inherit
//   the user's interactive `.zshrc` / `.bashrc`. Doppler-issued tokens
//   exported in an interactive shell are therefore unreachable from the
//   hook. The sage3c solution (#1312): allowlist-narrowed parser of a
//   single, top-of-repo `.env` file. The .env holds only the Doppler
//   service token; the loader hoists it into the hook's process env.
//
//   The same shape works for any consumer repo with the same constraint.
//   The OSS implementation accepts the allowlist as a parameter so each
//   repo's convention (`DOPPLER_SERVICE_TOKEN_ACME`, etc.) is opt-in.
//
// Defense-in-depth carried over from sage3c:
//   - KEY must match `/^[A-Z_][A-Z0-9_]*$/`. Anything else is dropped
//     before the allowlist check (typo / accidental punctuation).
//   - VALUE must not contain `[`$;&|<>]` — a Doppler service token is
//     base64url, so these characters cannot legitimately appear. If the
//     .env has been tampered to inject a command substitution, drop the
//     line.
//   - Strips one layer of matched single/double quotes from the value.
//   - The loader does NOT overwrite already-set env vars; an exported
//     value in the user's shell wins.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

// Default allowlist for the OSS CLI. Just `DOPPLER_TOKEN`. Consumers
// that use project-scoped service token vars pass their own list.
export const DEFAULT_BOOTSTRAP_ALLOWLIST = Object.freeze(["DOPPLER_TOKEN"] as const);

export type BootstrapStatus =
  | "ok"
  | "no-bootstrap-file"
  | "no-allowlisted-keys"
  | "parse-error"
  | "not-in-git";

export interface BootstrapResult {
  loadedKeys: string[];
  mappedToDopplerToken: boolean;
  status: BootstrapStatus;
  message: string;
  source?: string;
}

export interface BootstrapOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  // Override the discovered main-checkout root. Tests use this to bypass
  // the git rev-parse step; production code should leave it unset.
  mainCheckoutRoot?: string;
  // Allowlist of env keys the loader will read from .env. Default:
  // `["DOPPLER_TOKEN"]`. Consumers that use project-scoped service-token
  // vars (e.g. `DOPPLER_SERVICE_TOKEN_ACME`) supply their own list here.
  // The allowlist is intentionally a closed set — adding a key should be
  // a deliberate security review at the consumer's repo.
  allowlist?: ReadonlyArray<string>;
  // When set, the loader copies the value of this env var into
  // `DOPPLER_TOKEN` if the latter is unset. This is the sage3c
  // "DOPPLER_SERVICE_TOKEN_SAGE → DOPPLER_TOKEN" bridge, generalized.
  // The alias key must also appear in `allowlist`.
  serviceTokenAlias?: string;
}

// Strict KEY=value shape. The KEY must match this pattern; anything else
// gets dropped before the allowlist is even consulted.
const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

// Defense-in-depth: a Doppler service token is `dp.st.<env>.<base64url>` —
// none of these characters can legitimately appear in a value. If the .env
// has been tampered to inject a command substitution, drop the line.
const FORBIDDEN_VALUE_CHARS = /[`$;&|<>]/;

function findMainCheckoutRoot(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    const absolute = out.startsWith("/") ? out : resolve(cwd, out);
    // The common dir is `<main-checkout>/.git`. Its parent is the main
    // checkout root. (Bare repositories have no checkout and therefore no
    // .env to bootstrap — treat them as "not in a git checkout" for the
    // purposes of this loader.)
    if (!absolute.endsWith("/.git") && absolute !== ".git") return null;
    return resolve(absolute, "..");
  } catch {
    return null;
  }
}

interface ParsedLine {
  key: string;
  value: string;
}

function parseLine(rawLine: string): ParsedLine | null {
  // Trim leading whitespace only — trailing whitespace stays attached to the
  // value, where we'll strip surrounding quotes (if any) and validate.
  const line = rawLine.replace(/^\s+/, "");
  if (line === "" || line.startsWith("#")) return null;
  const eqIdx = line.indexOf("=");
  if (eqIdx <= 0) return null;
  const key = line.slice(0, eqIdx);
  if (!KEY_PATTERN.test(key)) return null;
  let value = line.slice(eqIdx + 1).replace(/\s+$/, "");
  // Strip a single layer of matched single or double quotes.
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  if (FORBIDDEN_VALUE_CHARS.test(value)) return null;
  return { key, value };
}

export function loadDopplerBootstrapEnv(
  options: BootstrapOptions = {},
): BootstrapResult {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const allowlist = options.allowlist ?? DEFAULT_BOOTSTRAP_ALLOWLIST;
  const root = options.mainCheckoutRoot ?? findMainCheckoutRoot(cwd);

  if (!root) {
    return {
      loadedKeys: [],
      mappedToDopplerToken: false,
      status: "not-in-git",
      message:
        "df bootstrap: cwd is not inside a git checkout; skipping Doppler bootstrap loader.",
    };
  }

  const envPath = resolve(root, ".env");

  if (!existsSync(envPath)) {
    return {
      loadedKeys: [],
      mappedToDopplerToken: false,
      status: "no-bootstrap-file",
      message: `df bootstrap: no .env at ${envPath} (relying on shell-exported Doppler tokens, if any).`,
      source: envPath,
    };
  }

  try {
    const st = statSync(envPath);
    if (!st.isFile() || st.size === 0) {
      return {
        loadedKeys: [],
        mappedToDopplerToken: false,
        status: "no-bootstrap-file",
        message: `df bootstrap: ${envPath} exists but is empty.`,
        source: envPath,
      };
    }
  } catch {
    return {
      loadedKeys: [],
      mappedToDopplerToken: false,
      status: "parse-error",
      message: `df bootstrap: failed to stat ${envPath}.`,
      source: envPath,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return {
      loadedKeys: [],
      mappedToDopplerToken: false,
      status: "parse-error",
      message: `df bootstrap: failed to read ${envPath}.`,
      source: envPath,
    };
  }

  const allowSet = new Set<string>(allowlist);
  const loadedKeys: string[] = [];
  let sawAllowlistedLine = false;
  for (const rawLine of raw.split(/\r?\n/)) {
    const parsed = parseLine(rawLine);
    if (!parsed) continue;
    if (!allowSet.has(parsed.key)) continue;
    sawAllowlistedLine = true;
    const existing = env[parsed.key];
    if (existing !== undefined && existing !== "") continue;
    env[parsed.key] = parsed.value;
    loadedKeys.push(parsed.key);
  }

  let mappedToDopplerToken = false;
  if (options.serviceTokenAlias) {
    const alias = options.serviceTokenAlias;
    // Only honor an alias that also appears in the allowlist — otherwise
    // the loader would never have read it from .env anyway.
    if (allowSet.has(alias)) {
      const aliasValue = env[alias];
      const token = env["DOPPLER_TOKEN"];
      if (aliasValue && (token === undefined || token === "")) {
        env["DOPPLER_TOKEN"] = aliasValue;
        mappedToDopplerToken = true;
      }
    }
  }

  if (!sawAllowlistedLine) {
    return {
      loadedKeys: [],
      mappedToDopplerToken,
      status: "no-allowlisted-keys",
      message: `df bootstrap: ${envPath} contained no allowlisted Doppler keys (allowlist=${Array.from(allowSet).join(",")}).`,
      source: envPath,
    };
  }

  return {
    loadedKeys,
    mappedToDopplerToken,
    status: "ok",
    message:
      loadedKeys.length > 0
        ? `df bootstrap: loaded ${loadedKeys.length} allowlisted Doppler key(s) from ${envPath}.`
        : `df bootstrap: ${envPath} processed; all allowlisted keys were already set in the environment.`,
    source: envPath,
  };
}
