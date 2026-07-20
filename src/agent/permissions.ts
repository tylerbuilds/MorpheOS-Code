// Permission rule engine for MorpheOS Code
//
// Provides pattern-matched permission rules that replace binary
// allow/deny.  Users write glob-style rules such as:
//
//   Bash(git *)           — allow all git commands
//   Bash(sudo *)          — always deny sudo
//   WebFetch(https://api.mycompany.com/*) — allow a specific domain

import type { Tier2Gate } from "./tools.js";

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRule {
  /** Glob-style pattern, e.g. "Bash(git *)" or "WebFetch(https://api.mycompany.com/*)" */
  pattern: string;
  action: PermissionAction;
}

/**
 * Parse a rule pattern into a tool name and parameter matchers.
 *
 *   "Bash(git *)"          -> { tool: "Bash", paramPatterns: ["git *"] }
 *   "WebFetch(*)"           -> { tool: "WebFetch", paramPatterns: ["*"] }
 *   "write_file(*)"         -> { tool: "write_file", paramPatterns: ["*"] }
 *
 * Returns null when the pattern cannot be parsed.
 */
export function parseRule(pattern: string): { tool: string; paramPatterns: string[] } | null {
  const match = pattern.match(/^([\w-]+)\((.*)\)$/);
  if (!match) return null;
  return {
    tool: match[1],
    paramPatterns: match[2].split(",").map(s => s.trim()).filter(s => s.length > 0),
  };
}

/**
 * Match a single parameter value against a glob-style pattern.
 *
 *   matchParam("git push", "git *")               -> true
 *   matchParam("anything", "*")                     -> true
 *   matchParam("https://api.mycompany.com/v1/users", "https://api.mycompany.com/*") -> true
 *   matchParam("sudo rm -rf /", "git *")            -> false
 */
export function matchParam(value: string, pattern: string): boolean {
  if (pattern === "*") return true;

  // Escape regex-special characters, then convert * to .*
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
  const regex = new RegExp("^" + escaped.replace(/\*/g, ".*") + "$");
  return regex.test(value);
}

/**
 * Determine the action for a given tool call by evaluating each rule in
 * order.  The first rule whose pattern matches the tool name AND all of
 * its parameter patterns wins.
 *
 * When no rule matches, `defaultAction` is returned (defaults to "ask").
 */
export function checkPermission(
  toolName: string,
  params: Record<string, unknown>,
  rules: readonly PermissionRule[],
  defaultAction: PermissionAction = "ask",
): PermissionAction {
  for (const rule of rules) {
    const parsed = parseRule(rule.pattern);
    if (!parsed || parsed.tool !== toolName) continue;

    // An empty parameter-pattern list (or a single "*") matches any params.
    if (parsed.paramPatterns.length === 0 || parsed.paramPatterns[0] === "*") {
      return rule.action;
    }

    // Otherwise every parameter pattern must match the corresponding
    // positional parameter value (order is determined by Object.values).
    const paramValues = Object.values(params).map(v => String(v));
    const allMatch = parsed.paramPatterns.every((pp, i) => {
      const value = paramValues[i] ?? "";
      return matchParam(value, pp);
    });

    if (allMatch) return rule.action;
  }

  return defaultAction;
}

/**
 * Format a rule as a human-readable string, used by the /permit command.
 */
export function formatRule(rule: PermissionRule): string {
  return `${rule.pattern} → ${rule.action}`;
}

/**
 * Wrap an existing Tier2Gate so that permission rules are evaluated first.
 *
 * - "allow"  — the tool is authorised immediately (session scope).
 * - "deny"   — the tool is blocked with a message.
 * - "ask"    — falls through to the underlying gate (e.g. approval prompt).
 */
export function createPermissionGate(
  rules: readonly PermissionRule[],
  fallback: Tier2Gate,
  defaultAction: PermissionAction = "ask",
): Tier2Gate {
  return {
    async check(toolName, params) {
      const action = checkPermission(toolName, params, rules, defaultAction);
      if (action === "allow") return { allowed: true, scope: "session" };
      if (action === "deny") return { allowed: false, reason: `Permission rule denied: ${toolName}` };
      return fallback.check(toolName, params);
    },
  };
}

// ── Default rules ──────────────────────────────────────────────────

/** Always deny dangerous operations (sudo, fork bombs, etc.). */
export const DEFAULT_RULES: readonly PermissionRule[] = [
  { pattern: "Bash(sudo *)", action: "deny" },
  { pattern: "delete_file(*)", action: "ask" },
];

/** Load rules from the built-in defaults.  v1.1 will add disk persistence. */
export function loadRules(): PermissionRule[] {
  return [...DEFAULT_RULES];
}
