import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CheckpointManager, type Checkpoint } from "../src/agent/checkpoint.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "morpheos-checkpoint-"));
}

test("snapshot creates checkpoint from existing file", () => {
  const dir = tempDir();
  const cm = new CheckpointManager(dir);
  const filePath = path.join(dir, "test.txt");
  fs.writeFileSync(filePath, "original content", "utf8");

  const ck = cm.snapshot(filePath, "write_file", "write_file on test.txt");

  assert.ok(ck, "checkpoint should be created");
  assert.equal(ck!.filePath, path.resolve(filePath));
  assert.equal(ck!.content, "original content");
  assert.equal(ck!.toolCall, "write_file");
  assert.ok(ck!.id.startsWith("ck_"));
  assert.equal(cm.count(), 1);
});

test("snapshot returns null for non-existent file", () => {
  const dir = tempDir();
  const cm = new CheckpointManager(dir);
  const filePath = path.join(dir, "nonexistent.txt");

  const ck = cm.snapshot(filePath, "write_file", "write_file on nonexistent.txt");

  assert.equal(ck, null);
  assert.equal(cm.count(), 0);
});

test("restore writes checkpoint content back to file", () => {
  const dir = tempDir();
  const cm = new CheckpointManager(dir);
  const filePath = path.join(dir, "test.txt");
  fs.writeFileSync(filePath, "original content", "utf8");

  const ck = cm.snapshot(filePath, "write_file", "write_file on test.txt");
  assert.ok(ck);

  // Mutate the file
  fs.writeFileSync(filePath, "changed content", "utf8");
  assert.equal(fs.readFileSync(filePath, "utf8"), "changed content");

  // Restore from checkpoint
  const restored = cm.restore(ck!.id);
  assert.equal(restored, true);
  assert.equal(fs.readFileSync(filePath, "utf8"), "original content");
});

test("undo reverts most recent change", () => {
  const dir = tempDir();
  const cm = new CheckpointManager(dir);
  const filePath = path.join(dir, "test.txt");
  fs.writeFileSync(filePath, "version 1", "utf8");

  // Snapshot v1
  const ck1 = cm.snapshot(filePath, "write_file", "write version 1");
  assert.ok(ck1);

  // Change to v2 — normally a snapshot would happen before, but we simulate the mutation directly
  fs.writeFileSync(filePath, "version 2", "utf8");

  // Undo should restore v1
  const undone = cm.undo();
  assert.ok(undone);
  assert.equal(undone!.id, ck1!.id);
  assert.equal(fs.readFileSync(filePath, "utf8"), "version 1");
});

test("undo with file path targets specific file", () => {
  const dir = tempDir();
  const cm = new CheckpointManager(dir);

  const fileA = path.join(dir, "a.txt");
  const fileB = path.join(dir, "b.txt");

  fs.writeFileSync(fileA, "A content", "utf8");
  fs.writeFileSync(fileB, "B content", "utf8");

  const ckA = cm.snapshot(fileA, "write_file", "write a.txt");
  const ckB = cm.snapshot(fileB, "write_file", "write b.txt");

  assert.ok(ckA);
  assert.ok(ckB);
  assert.equal(cm.count(), 2);

  // Mutate both
  fs.writeFileSync(fileA, "A changed", "utf8");
  fs.writeFileSync(fileB, "B changed", "utf8");

  // Undo only fileA
  const undone = cm.undo(fileA);
  assert.ok(undone);
  assert.equal(undone!.id, ckA!.id);
  assert.equal(fs.readFileSync(fileA, "utf8"), "A content");
  // fileB should remain changed
  assert.equal(fs.readFileSync(fileB, "utf8"), "B changed");
});

test("list returns most recent checkpoints first", () => {
  const dir = tempDir();
  const cm = new CheckpointManager(dir);

  const file1 = path.join(dir, "1.txt");
  const file2 = path.join(dir, "2.txt");
  const file3 = path.join(dir, "3.txt");

  fs.writeFileSync(file1, "one", "utf8");
  fs.writeFileSync(file2, "two", "utf8");
  fs.writeFileSync(file3, "three", "utf8");

  const ck1 = cm.snapshot(file1, "write_file", "write 1.txt");
  const ck2 = cm.snapshot(file2, "write_file", "write 2.txt");
  const ck3 = cm.snapshot(file3, "write_file", "write 3.txt");

  const list = cm.list();
  assert.equal(list.length, 3);
  // Most recent first
  assert.equal(list[0].id, ck3!.id);
  assert.equal(list[1].id, ck2!.id);
  assert.equal(list[2].id, ck1!.id);

  // limit
  assert.equal(cm.list(2).length, 2);
});

test("checkpoint cap at 50 in memory", () => {
  const dir = tempDir();
  const cm = new CheckpointManager(dir);

  // Create 55 checkpoints on different files
  for (let i = 0; i < 55; i++) {
    const filePath = path.join(dir, `file-${i}.txt`);
    fs.writeFileSync(filePath, `content ${i}`, "utf8");
    cm.snapshot(filePath, "write_file", `write file-${i}.txt`);
  }

  // Memory should cap at 50
  assert.equal(cm.count(), 50);
  // The most recent 50 should be in memory; oldest 5 should be dropped from memory
  // but persisted to disk
  const list = cm.list(50);
  assert.equal(list.length, 50);
});

test("disk persistence — checkpoint survives manager recreation", () => {
  const dir = tempDir();
  const filePath = path.join(dir, "test.txt");
  fs.writeFileSync(filePath, "persistent content", "utf8");

  // Create manager, snapshot, then destroy
  const cm1 = new CheckpointManager(dir);
  const ck = cm1.snapshot(filePath, "write_file", "write test.txt");
  assert.ok(ck);

  // Create a new manager on the same root
  const cm2 = new CheckpointManager(dir);
  // The in-memory list starts empty, but disk should have the checkpoint
  const found = cm2.findCheckpoint(ck!.id);
  assert.ok(found);
  assert.equal(found!.id, ck!.id);
  assert.equal(found!.content, "persistent content");
});

test("findCheckpoint from memory", () => {
  const dir = tempDir();
  const cm = new CheckpointManager(dir);
  const filePath = path.join(dir, "test.txt");
  fs.writeFileSync(filePath, "hello", "utf8");

  const ck = cm.snapshot(filePath, "edit_file", "edit test.txt");
  assert.ok(ck);

  const found = cm.findCheckpoint(ck!.id);
  assert.ok(found);
  assert.equal(found!.id, ck!.id);
});

test("findCheckpoint from disk", () => {
  const dir = tempDir();
  const filePath = path.join(dir, "test.txt");
  fs.writeFileSync(filePath, "disk find content", "utf8");

  // Create manager, snapshot, then create fresh manager (empty memory)
  const cm1 = new CheckpointManager(dir);
  const ck = cm1.snapshot(filePath, "delete_file", "delete test.txt");
  assert.ok(ck);

  const cm2 = new CheckpointManager(dir);
  // Should find it from disk even though memory is empty
  const found = cm2.findCheckpoint(ck!.id);
  assert.ok(found);
  assert.equal(found!.filePath, path.resolve(filePath));
});

test("count tracks active checkpoints", () => {
  const dir = tempDir();
  const cm = new CheckpointManager(dir);

  assert.equal(cm.count(), 0);

  const file1 = path.join(dir, "a.txt");
  fs.writeFileSync(file1, "a", "utf8");
  cm.snapshot(file1, "write_file", "write a");
  assert.equal(cm.count(), 1);

  const file2 = path.join(dir, "b.txt");
  fs.writeFileSync(file2, "b", "utf8");
  cm.snapshot(file2, "write_file", "write b");
  assert.equal(cm.count(), 2);

  const file3 = path.join(dir, "c.txt");
  fs.writeFileSync(file3, "c", "utf8");
  cm.snapshot(file3, "write_file", "write c");
  assert.equal(cm.count(), 3);
});

test("undo on non-existent file returns null", () => {
  const dir = tempDir();
  const cm = new CheckpointManager(dir);

  const undone = cm.undo("/some/nonexistent/file.txt");
  assert.equal(undone, null);
});

test("restore non-existent checkpoint returns false", () => {
  const dir = tempDir();
  const cm = new CheckpointManager(dir);

  const result = cm.restore("nonexistent_id");
  assert.equal(result, false);
});

test("undo creates redo checkpoint on disk", () => {
  const dir = tempDir();
  const cm = new CheckpointManager(dir);
  const filePath = path.join(dir, "test.txt");
  fs.writeFileSync(filePath, "before undo", "utf8");

  const ck = cm.snapshot(filePath, "write_file", "write test.txt");
  assert.ok(ck);

  // Change the file
  fs.writeFileSync(filePath, "after change", "utf8");

  // Undo — this should create a redo checkpoint on disk
  const undone = cm.undo();
  assert.ok(undone);

  // Check that the redo checkpoint file exists on disk
  const redoCkPath = path.join(dir, ".morpheos/checkpoints", `redo_${ck!.id}.json`);
  assert.ok(fs.existsSync(redoCkPath), "redo checkpoint should be persisted to disk");
  const redoCk = JSON.parse(fs.readFileSync(redoCkPath, "utf8")) as Checkpoint;
  assert.equal(redoCk.content, "after change");
  assert.ok(redoCk.id.startsWith("redo_"));
});
