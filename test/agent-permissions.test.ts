import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRule,
  matchParam,
  checkPermission,
  loadRules,
  DEFAULT_RULES,
  formatRule,
  type PermissionRule,
} from "../src/agent/permissions.js";

// ── parseRule ──────────────────────────────────────────────────────

test("parseRule extracts tool and single param pattern", () => {
  const result = parseRule("Bash(git *)");
  assert.deepEqual(result, { tool: "Bash", paramPatterns: ["git *"] });
});

test("parseRule extracts multiple param patterns", () => {
  const result = parseRule("Tool(a, b, c)");
  assert.deepEqual(result, { tool: "Tool", paramPatterns: ["a", "b", "c"] });
});

test("parseRule handles wildcard-only pattern", () => {
  const result = parseRule("WebFetch(*)");
  assert.deepEqual(result, { tool: "WebFetch", paramPatterns: ["*"] });
});

test("parseRule handles empty parens as empty patterns", () => {
  const result = parseRule("Tool()");
  assert.deepEqual(result, { tool: "Tool", paramPatterns: [] });
});

test("parseRule handles tool names with hyphens", () => {
  const result = parseRule("run_command(ls -la)");
  assert.deepEqual(result, { tool: "run_command", paramPatterns: ["ls -la"] });
});

test("parseRule returns null for malformed pattern without parens", () => {
  assert.equal(parseRule("Bash"), null);
});

test("parseRule returns null for empty string", () => {
  assert.equal(parseRule(""), null);
});

// ── matchParam ─────────────────────────────────────────────────────

test("matchParam matches wildcard against anything", () => {
  assert.equal(matchParam("anything at all", "*"), true);
  assert.equal(matchParam("", "*"), true);
  assert.equal(matchParam("sudo rm -rf /", "*"), true);
});

test("matchParam matches prefix glob", () => {
  assert.equal(matchParam("git push", "git *"), true);
  assert.equal(matchParam("git status", "git *"), true);
  assert.equal(matchParam("git log --oneline", "git *"), true);
});

test("matchParam matches middle glob", () => {
  assert.equal(matchParam("https://api.mycompany.com/v1/users", "https://api.mycompany.com/*"), true);
  assert.equal(matchParam("https://api.mycompany.com/", "https://api.mycompany.com/*"), true);
});

test("matchParam rejects non-matching patterns", () => {
  assert.equal(matchParam("sudo rm -rf /", "git *"), false);
  assert.equal(matchParam("git", "git *"), false);           // no space after git
  assert.equal(matchParam("https://evil.com", "https://api.mycompany.com/*"), false);
});

test("matchParam handles exact match", () => {
  assert.equal(matchParam("exact", "exact"), true);
  assert.equal(matchParam("exact", "exac"), false);
});

// ── checkPermission ────────────────────────────────────────────────

test("checkPermission returns ask when no rules match", () => {
  const result = checkPermission("SomeTool", {}, []);
  assert.equal(result, "ask");
});

test("checkPermission returns first matching rule action", () => {
  const rules: PermissionRule[] = [
    { pattern: "Bash(git *)", action: "allow" },
    { pattern: "Bash(*)", action: "deny" },
  ];
  assert.equal(checkPermission("Bash", { command: "git push" }, rules), "allow");
});

test("checkPermission falls through to second rule when first does not match", () => {
  const rules: PermissionRule[] = [
    { pattern: "Bash(git *)", action: "allow" },
    { pattern: "Bash(*)", action: "deny" },
  ];
  // "ls" does not match "git *" so it falls through to "deny"
  assert.equal(checkPermission("Bash", { command: "ls" }, rules), "deny");
});

test("checkPermission honours default action parameter", () => {
  const result = checkPermission("SomeTool", {}, [], "deny");
  assert.equal(result, "deny");
});

test("checkPermission matches tool-name-only wildcard rule", () => {
  const rules: PermissionRule[] = [
    { pattern: "WebFetch(*)", action: "allow" },
  ];
  assert.equal(checkPermission("WebFetch", { url: "https://any.com" }, rules), "allow");
});

test("checkPermission returns deny from matching deny rule", () => {
  const rules: PermissionRule[] = [
    { pattern: "Bash(sudo *)", action: "deny" },
  ];
  assert.equal(checkPermission("Bash", { command: "sudo rm -rf /" }, rules), "deny");
});

test("checkPermission matches multiple params in order", () => {
  const rules: PermissionRule[] = [
    { pattern: "Tool(a, b)", action: "allow" },
  ];
  assert.equal(checkPermission("Tool", { first: "a", second: "b" }, rules), "allow");
  assert.equal(checkPermission("Tool", { first: "a", second: "c" }, rules), "ask");
});

// ── Rule ordering (first match wins) ───────────────────────────────

test("first matching rule wins — specific before general", () => {
  const rules: PermissionRule[] = [
    { pattern: "Bash(git *)", action: "allow" },
    { pattern: "Bash(*)", action: "deny" },
  ];
  assert.equal(checkPermission("Bash", { command: "git push" }, rules), "allow");
  assert.equal(checkPermission("Bash", { command: "npm install" }, rules), "deny");
});

test("first matching rule wins — deny before allow", () => {
  const rules: PermissionRule[] = [
    { pattern: "Bash(sudo *)", action: "deny" },
    { pattern: "Bash(*)", action: "allow" },
  ];
  assert.equal(checkPermission("Bash", { command: "sudo rm -rf /" }, rules), "deny");
  assert.equal(checkPermission("Bash", { command: "ls" }, rules), "allow");
});

// ── Default rules ──────────────────────────────────────────────────

test("DEFAULT_RULES deny sudo commands", () => {
  assert.equal(checkPermission("Bash", { command: "sudo apt update" }, DEFAULT_RULES), "deny");
});

test("DEFAULT_RULES ask for delete_file", () => {
  assert.equal(checkPermission("delete_file", { file_path: "/tmp/test" }, DEFAULT_RULES), "ask");
});

test("DEFAULT_RULES do not block benign Bash commands", () => {
  assert.equal(checkPermission("Bash", { command: "git status" }, DEFAULT_RULES), "ask");
});

test("loadRules returns a mutable copy of defaults", () => {
  const rules = loadRules();
  assert.ok(Array.isArray(rules));
  assert.ok(rules.length >= 2);
  // Verify it is a copy, not the original frozen array
  rules.push({ pattern: "Test(*)", action: "allow" });
  assert.equal(rules.length, DEFAULT_RULES.length + 1);
});

// ── Edge cases ─────────────────────────────────────────────────────

test("checkPermission handles empty params object", () => {
  const rules: PermissionRule[] = [
    { pattern: "Tool()", action: "allow" },
  ];
  // Tool() parses to empty paramPatterns, which matches anything
  assert.equal(checkPermission("Tool", {}, rules), "allow");
});

test("checkPermission handles params with missing positional values", () => {
  const rules: PermissionRule[] = [
    { pattern: "Tool(a, b)", action: "allow" },
  ];
  // Only one param value, second is "" which will not match "b"
  assert.equal(checkPermission("Tool", { first: "a" }, rules), "ask");
  // But if second pattern was "*" it would match
  const rules2: PermissionRule[] = [
    { pattern: "Tool(a, *)", action: "allow" },
  ];
  assert.equal(checkPermission("Tool", { first: "a" }, rules2), "allow");
});

test("checkPermission handles tool name case-sensitively", () => {
  const rules: PermissionRule[] = [
    { pattern: "bash(*)", action: "allow" },
  ];
  assert.equal(checkPermission("Bash", { command: "ls" }, rules), "ask");
});

// ── Unicode and special characters ─────────────────────────────────

test("matchParam handles Unicode in values", () => {
  assert.equal(matchParam("café résumé", "café *"), true);
  assert.equal(matchParam("привет мир", "привет *"), true);
});

test("matchParam escapes regex-special characters", () => {
  assert.equal(matchParam("test.com/page?a=1", "test.com/page?a=*"), true);
  assert.equal(matchParam("value [bracketed]", "value [bracketed]"), true);
  assert.equal(matchParam("file.txt", "file.txt"), true);
});

// ── formatRule ─────────────────────────────────────────────────────

test("formatRule produces human-readable string", () => {
  assert.equal(formatRule({ pattern: "Bash(git *)", action: "allow" }), "Bash(git *) → allow");
  assert.equal(formatRule({ pattern: "Bash(sudo *)", action: "deny" }), "Bash(sudo *) → deny");
});
