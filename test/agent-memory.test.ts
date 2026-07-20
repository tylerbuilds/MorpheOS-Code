import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MemoryManager } from "../src/agent/memory.js";

// Helper: create a temp directory and return its path
function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "morpheos-memory-test-"));
}

// Helper: clean up a temp directory
function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── MemoryManager: basic creation ────────────────────────────────────

test("MemoryManager creates .morpheos directory on saveEntry", async () => {
  const root = tempDir();
  try {
    const manager = new MemoryManager(root);
    // Directory should not exist yet
    assert.equal(fs.existsSync(path.join(root, ".morpheos")), false);

    await manager.saveEntry("Learned how to build the project");
    // Directory should now exist
    assert.equal(fs.existsSync(path.join(root, ".morpheos")), true);
    assert.equal(fs.existsSync(path.join(root, ".morpheos", "MEMORY.md")), true);
  } finally {
    cleanup(root);
  }
});

// ── loadContext ──────────────────────────────────────────────────────

test("loadContext returns null when no file exists", () => {
  const root = tempDir();
  try {
    const manager = new MemoryManager(root);
    const ctx = manager.loadContext();
    assert.equal(ctx, null);
  } finally {
    cleanup(root);
  }
});

// ── saveEntry ────────────────────────────────────────────────────────

test("saveEntry creates file and prepends entries", async () => {
  const root = tempDir();
  try {
    const manager = new MemoryManager(root);
    await manager.saveEntry("First learning");
    await manager.saveEntry("Second learning");

    const content = fs.readFileSync(manager.memoryPath, "utf8");
    const lines = content.trim().split("\n");

    // Newest entry should be first (prepended)
    assert.ok(lines[0].includes("Second learning"), "Newest entry should be first");
    assert.ok(lines[1].includes("First learning"), "Older entry should be second");
  } finally {
    cleanup(root);
  }
});

test("saveEntry includes timestamp in each entry", async () => {
  const root = tempDir();
  try {
    const manager = new MemoryManager(root);
    await manager.saveEntry("Test memory");

    const content = fs.readFileSync(manager.memoryPath, "utf8");
    // Should contain an ISO timestamp pattern like [YYYY-MM-DDTHH:mm:ss]
    assert.match(content, /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\]/);
  } finally {
    cleanup(root);
  }
});

// ── loadContext line limit ───────────────────────────────────────────

test("loadContext respects line limit (200 lines)", async () => {
  const root = tempDir();
  try {
    const manager = new MemoryManager(root);

    // Create 250 entries
    for (let i = 0; i < 250; i++) {
      await manager.saveEntry(`Memory entry number ${i}`);
    }

    const ctx = manager.loadContext();
    assert.ok(ctx !== null, "loadContext should return content");
    const lines = ctx!.split("\n");
    assert.ok(lines.length <= 200, `Should have at most 200 lines, got ${lines.length}`);
  } finally {
    cleanup(root);
  }
});

// ── loadContext byte limit ───────────────────────────────────────────

test("loadContext respects byte limit (25KB)", async () => {
  const root = tempDir();
  try {
    const manager = new MemoryManager(root);

    // Create entries with large content to exceed byte limit
    const largeEntry = "x".repeat(200);
    for (let i = 0; i < 200; i++) {
      await manager.saveEntry(`Entry ${i}: ${largeEntry}`);
    }

    const ctx = manager.loadContext();
    assert.ok(ctx !== null, "loadContext should return content");
    const byteLength = Buffer.byteLength(ctx!, "utf8");
    assert.ok(byteLength <= 25000, `Should be at most 25000 bytes, got ${byteLength}`);
  } finally {
    cleanup(root);
  }
});

// ── saveTopic / loadTopic ────────────────────────────────────────────

test("saveTopic creates topic files", async () => {
  const root = tempDir();
  try {
    const manager = new MemoryManager(root);
    await manager.saveTopic("debugging", "Use --inspect flag for Node debugging.");

    const topicPath = path.join(manager.topicsDir, "debugging.md");
    assert.equal(fs.existsSync(topicPath), true);

    const content = fs.readFileSync(topicPath, "utf8");
    assert.ok(content.includes("# debugging"), "Topic file should have header");
    assert.ok(content.includes("Use --inspect flag"), "Topic file should have content");
  } finally {
    cleanup(root);
  }
});

test("loadTopic returns content for valid topics", async () => {
  const root = tempDir();
  try {
    const manager = new MemoryManager(root);
    await manager.saveTopic("api-conventions", "All APIs use JSON responses with { ok, data } envelope.");

    const topic = manager.loadTopic("api-conventions");
    assert.ok(topic !== null, "loadTopic should return content");
    assert.ok(topic!.includes("JSON responses"), "Content should match what was saved");
    assert.ok(topic!.includes("# api-conventions"), "Content should include header");
  } finally {
    cleanup(root);
  }
});

test("loadTopic returns null for non-existent topics", () => {
  const root = tempDir();
  try {
    const manager = new MemoryManager(root);
    const topic = manager.loadTopic("nonexistent");
    assert.equal(topic, null);
  } finally {
    cleanup(root);
  }
});

// ── listTopics ───────────────────────────────────────────────────────

test("listTopics returns available topic names", async () => {
  const root = tempDir();
  try {
    const manager = new MemoryManager(root);
    await manager.saveTopic("debugging", "...");
    await manager.saveTopic("build", "...");
    await manager.saveTopic("api-conventions", "...");

    const topics = manager.listTopics();
    assert.deepEqual(topics.sort(), ["api-conventions", "build", "debugging"].sort());
  } finally {
    cleanup(root);
  }
});

test("listTopics returns empty array when no topics exist", () => {
  const root = tempDir();
  try {
    const manager = new MemoryManager(root);
    const topics = manager.listTopics();
    assert.deepEqual(topics, []);
  } finally {
    cleanup(root);
  }
});

// ── Topic name sanitization ──────────────────────────────────────────

test("Topic name sanitization replaces special characters", async () => {
  const root = tempDir();
  try {
    const manager = new MemoryManager(root);

    // Names with special characters should be sanitized
    await manager.saveTopic("Debugging & Profiling!", "content");
    await manager.saveTopic("API/v2 Conventions", "content");
    await manager.saveTopic("Build/Deploy Pipeline (2024)", "content");

    const expectedFiles = [
      "debugging---profiling.md",
      "api-v2-conventions.md",
      "build-deploy-pipeline--2024.md",
    ];

    for (const expected of expectedFiles) {
      const filePath = path.join(manager.topicsDir, expected);
      assert.equal(fs.existsSync(filePath), true, `Expected file ${expected} to exist`);
    }
  } finally {
    cleanup(root);
  }
});

test("Topic name sanitization lowercases and trims", async () => {
  const root = tempDir();
  try {
    const manager = new MemoryManager(root);
    await manager.saveTopic("  My TOPIC Name  ", "content");

    // The sanitized name should be lowercase and have no leading/trailing hyphens
    const topics = manager.listTopics();
    assert.equal(topics.length, 1);
    const name = topics[0];
    assert.ok(!name.startsWith("-"), "Should not start with hyphen");
    assert.ok(!name.endsWith("-"), "Should not end with hyphen");
    assert.equal(name, name.toLowerCase(), "Should be lowercase");
  } finally {
    cleanup(root);
  }
});

// ── Multiple entries maintain order ──────────────────────────────────

test("Multiple entries maintain order (newest first)", async () => {
  const root = tempDir();
  try {
    const manager = new MemoryManager(root);

    const entries = [
      "Entry A - first saved",
      "Entry B - second saved",
      "Entry C - third saved",
      "Entry D - fourth saved",
      "Entry E - fifth saved",
    ];

    for (const entry of entries) {
      await manager.saveEntry(entry);
    }

    const content = fs.readFileSync(manager.memoryPath, "utf8");
    const lines = content.trim().split("\n");

    // Latest entry (E) should be at line 0, earliest (A) at line 4
    assert.ok(lines[0].includes("Entry E"), `Line 0 should contain 'Entry E', got: ${lines[0]}`);
    assert.ok(lines[1].includes("Entry D"), `Line 1 should contain 'Entry D', got: ${lines[1]}`);
    assert.ok(lines[2].includes("Entry C"), `Line 2 should contain 'Entry C', got: ${lines[2]}`);
    assert.ok(lines[3].includes("Entry B"), `Line 3 should contain 'Entry B', got: ${lines[3]}`);
    assert.ok(lines[4].includes("Entry A"), `Line 4 should contain 'Entry A', got: ${lines[4]}`);
  } finally {
    cleanup(root);
  }
});

// ── exists ───────────────────────────────────────────────────────────

test("exists returns false when memory file does not exist", () => {
  const root = tempDir();
  try {
    const manager = new MemoryManager(root);
    assert.equal(manager.exists(), false);
  } finally {
    cleanup(root);
  }
});

test("exists returns true after saveEntry creates the file", async () => {
  const root = tempDir();
  try {
    const manager = new MemoryManager(root);
    assert.equal(manager.exists(), false);
    await manager.saveEntry("Test entry");
    assert.equal(manager.exists(), true);
  } finally {
    cleanup(root);
  }
});

// ── saveTopic creates topics subdirectory ────────────────────────────

test("saveTopic creates topics subdirectory automatically", async () => {
  const root = tempDir();
  try {
    const manager = new MemoryManager(root);
    // Topics dir should not exist initially
    assert.equal(fs.existsSync(manager.topicsDir), false);

    await manager.saveTopic("test", "content");
    assert.equal(fs.existsSync(manager.topicsDir), true);
  } finally {
    cleanup(root);
  }
});

// ── loadTopic handles names with mixed case/spaces ───────────────────

test("loadTopic handles names with mixed case by sanitizing", async () => {
  const root = tempDir();
  try {
    const manager = new MemoryManager(root);
    await manager.saveTopic("Build-Commands", "npm run build");

    // loadTopic should sanitize the input before looking up
    const result = manager.loadTopic("BUILD-COMMANDS");
    assert.ok(result !== null, "Should find topic regardless of case");
    assert.ok(result!.includes("npm run build"));
  } finally {
    cleanup(root);
  }
});
