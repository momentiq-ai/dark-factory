// `df skills install` — template renderer.
//
// Substitutes `{{VARIABLE}}` references in a template body with values
// resolved from the consumer's `darkfactory.yaml` (with sensible defaults
// per the skill's manifest).
//
// Design decisions:
//
// 1. Double-brace delimiter `{{X}}` for install-time variables. Single-brace
//    `{X}` is left UNTOUCHED — that delimiter is reserved for runtime variables
//    the agent fills at skill invocation (PR metadata, manifesto content, etc.).
//    This keeps install-time + runtime variable systems orthogonal in a single
//    file without escape-syntax acrobatics.
//
// 2. Strict variable resolution — any `{{VARIABLE}}` reference in the body must
//    be declared in the skill's `skill.json#variables`. Unknown references are
//    a render-time error (catches typos). Declared-but-not-overridden variables
//    use the manifest's `default`.
//
// 3. `kind: "list"` variables accept an array from the consumer config and
//    render one element per line (used for QUALITY_GATE_TARGETS). Scalar
//    variables substitute the value as-is (no escape — values are paths/names,
//    not arbitrary user input).
//
// 4. No conditional / loop syntax. If a future skill needs them, we'll lift in
//    handlebars; until then strict-substitution is enough and keeps the
//    surface area trivial to audit.

export interface SkillVariableDef {
  readonly description: string;
  readonly source?: string;
  readonly default: string;
  readonly kind?: "scalar" | "list";
}

export interface SkillManifest {
  readonly name: string;
  readonly version: string;
  readonly summary: string;
  readonly originatingRepo?: string;
  readonly files: ReadonlyArray<{ readonly template: string; readonly target: string }>;
  readonly variables: Readonly<Record<string, SkillVariableDef>>;
}

export type VariableOverride = string | ReadonlyArray<string>;

export interface RenderTemplateOptions {
  readonly manifest: SkillManifest;
  readonly overrides: Readonly<Record<string, VariableOverride>>;
}

/**
 * Regex matching `{{IDENTIFIER}}` (uppercase + digits + underscore, must
 * start with a letter). Conservative on purpose — keeps single-brace `{X}`
 * runtime variables and arbitrary mustache-like brace pairs out of scope.
 */
const VARIABLE_REGEX = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

/**
 * Resolve a variable's effective value: consumer override > manifest default.
 * For `kind: "list"`, an array override is rendered one-per-line; a string
 * override is treated as already-rendered. The manifest default is always a
 * string (lists are declared with a single-line scalar default representing
 * the minimal one-element list).
 */
function resolveValue(
  varName: string,
  def: SkillVariableDef,
  overrides: Readonly<Record<string, VariableOverride>>,
): string {
  const override = overrides[varName];
  if (override !== undefined) {
    if (Array.isArray(override)) {
      if (def.kind !== "list") {
        throw new Error(
          `skills: variable "${varName}" received an array override but its manifest declares kind: "scalar" (or omitted).`,
        );
      }
      return override.join("\n");
    }
    return String(override);
  }
  return def.default;
}

export interface RenderResult {
  readonly body: string;
  readonly substituted: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

/**
 * Render `body` by substituting every `{{VAR}}` reference using the skill's
 * manifest + the consumer's overrides. Throws on any reference whose
 * identifier is not declared in `manifest.variables`.
 */
export function renderTemplateBody(
  body: string,
  options: RenderTemplateOptions,
): RenderResult {
  const seen = new Map<string, string>();
  const rendered = body.replace(VARIABLE_REGEX, (_match, varName: string) => {
    const def = options.manifest.variables[varName];
    if (def === undefined) {
      throw new Error(
        `skills: template references undeclared variable "{{${varName}}}" — add it to skill.json#variables for skill "${options.manifest.name}".`,
      );
    }
    let value = seen.get(varName);
    if (value === undefined) {
      value = resolveValue(varName, def, options.overrides);
      seen.set(varName, value);
    }
    return value;
  });
  const substituted = Array.from(seen, ([name, value]) => ({ name, value }));
  return { body: rendered, substituted };
}

/**
 * Side-channel: list every `{{VAR}}` reference present in the body, in order
 * of first appearance (deduplicated). Used by the linter that validates a
 * manifest declares every variable its templates actually use.
 */
export function extractReferencedVariables(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = new RegExp(VARIABLE_REGEX.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const name = match[1] ?? "";
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}
