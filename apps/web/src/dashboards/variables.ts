import type { ResourceAttr } from "../api.ts";
import type { DashboardVariable } from "./types.ts";

// Matches a `${name}` token or a bare `$name` token. Variable names are
// letter-led identifiers (see the server-side dashboardVariableSchema), so the
// `\w+` capture is safe and won't greedily eat trailing punctuation.
const TOKEN_RE = /\$\{(\w+)\}|\$(\w+)/g;

// A value that is *only* a single variable reference, e.g. "$env" or "${env}".
const BARE_REF_RE = /^\$\{(\w+)\}$|^\$(\w+)$/;

export function isVariableRef(value: string): boolean {
  return BARE_REF_RE.test(value);
}

/** The variable name a bare reference points at, or null if not a bare ref. */
export function variableRefName(value: string): string | null {
  const m = BARE_REF_RE.exec(value);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

/**
 * Substitute `$name` / `${name}` tokens in a string with the selected variable
 * values. Unknown variables are left untouched so an unresolved reference is
 * visible rather than silently blanked.
 */
export function resolveVariableRefs(value: string, values: Record<string, string>): string {
  return value.replace(TOKEN_RE, (whole, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? "";
    return name in values ? (values[name] ?? "") : whole;
  });
}

/** Resolve variable references in every resourceAttr value, preserving key/op. */
export function resolveAttrsWithVariables(
  attrs: ResourceAttr[] | undefined,
  values: Record<string, string>,
): ResourceAttr[] | undefined {
  if (!attrs) return attrs;
  return attrs.map((a) => ({ ...a, value: resolveVariableRefs(a.value, values) }));
}

/**
 * Seed selection state for a dashboard's variables: the configured default, the
 * first option, or an empty string (free-form variables with no default).
 */
export function defaultVariableValues(variables: DashboardVariable[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of variables) {
    out[v.name] = v.defaultValue ?? v.options[0] ?? "";
  }
  return out;
}
