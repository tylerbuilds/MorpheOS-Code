import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createToolRegistry } from "../src/agent/tools.js";

const registry = createToolRegistry();

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-tools-"));
}

test("tool registry describes all 8 tools as function definitions", () => {
  const described = registry.describe();
  assert.equal(described.length, 8);
  for (const def of described) {
    assert.equal(def.type, "function");
    assert.ok(def.function.name.length > 0);
    assert.ok(def.function.description.length > 0);
  }
});

test("read_file returns numbered lines", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "test.txt");
  fs.writeFileSync(filePath, "line one\nline two\nline three\n", "utf8");
  const result = await registry.execute("read_file", { file_path: filePath }, dir);
  assert.equal(result.error, undefined);
  assert.ok(result.content.includes("     1\tline one"));
  assert.ok(result.content.includes("     2\tline two"));
  assert.ok(result.summary.includes("test.txt"));
});

test("read_file rejects relative paths", async () => {
  const result = await registry.execute("read_file", { file_path: "relative/path.txt" }, "/tmp");
  assert.ok(result.error);
});

test("write_file creates file and parent directories", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "nested", "subdir", "out.txt");
  const result = await registry.execute("write_file", { file_path: filePath, content: "hello world" }, dir);
  assert.equal(result.error, undefined);
  assert.ok(result.summary.includes("out.txt"));
  assert.equal(fs.readFileSync(filePath, "utf8"), "hello world");
});

test("edit_file replaces exact string", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "edit.txt");
  fs.writeFileSync(filePath, "const x = 1;\nconst y = 2;\n", "utf8");
  const result = await registry.execute("edit_file", {
    file_path: filePath,
    old_string: "const x = 1;",
    new_string: "const x = 42;",
  }, dir);
  assert.equal(result.error, undefined);
  assert.ok(result.summary.includes("edit.txt"));
  assert.ok(fs.readFileSync(filePath, "utf8").includes("const x = 42;"));
});

test("edit_file fails when old_string is not unique", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "dup.txt");
  fs.writeFileSync(filePath, "foo\nfoo\n", "utf8");
  const result = await registry.execute("edit_file", {
    file_path: filePath,
    old_string: "foo",
    new_string: "bar",
  }, dir);
  assert.ok(result.error);
});

test("edit_file fails when old and new strings are identical", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "same.txt");
  fs.writeFileSync(filePath, "hello", "utf8");
  const result = await registry.execute("edit_file", {
    file_path: filePath,
    old_string: "hello",
    new_string: "hello",
  }, dir);
  assert.ok(result.error);
});

test("search_content finds matches", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "a.ts"), "const API_KEY = 'secret';", "utf8");
  fs.writeFileSync(path.join(dir, "b.ts"), "const apiKey = process.env.KEY;", "utf8");
  const result = await registry.execute("search_content", { pattern: "KEY", directory: dir }, dir);
  assert.ok(result.summary.includes("matches"));
});

test("list_directory returns entries with type indicators", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "", "utf8");
  fs.mkdirSync(path.join(dir, "subdir"));
  const result = await registry.execute("list_directory", { directory: dir }, dir);
  assert.ok(result.content.includes("a.txt"));
  assert.ok(result.content.includes("subdir/"));
});

test("unknown tool returns error", async () => {
  const result = await registry.execute("nonexistent_tool", {}, "/tmp");
  assert.ok(result.error);
});

test("tier 2 tools blocked without gate authorisation", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "target.txt");
  fs.writeFileSync(filePath, "delete me", "utf8");
  const result = await registry.execute("delete_file", { file_path: filePath }, dir);
  assert.ok(result.error);
  assert.ok(result.error.includes("approval_required"));
  assert.ok(fs.existsSync(filePath)); // file still exists
});
