import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HarnessError } from "../src/errors.js";
import { HarnessStore, STATE_SCHEMA_VERSION } from "../src/store.js";

test("new and legacy state directories migrate to the supported schema", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-state-schema-"));
  const store = new HarnessStore(root);
  try {
    assert.equal(store.schemaVersion, STATE_SCHEMA_VERSION);
    const row = store.db.prepare("PRAGMA user_version;").get() as { user_version?: number };
    assert.equal(row.user_version, STATE_SCHEMA_VERSION);
  } finally {
    store.close();
  }
});

test("newer state schemas are refused without mutation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-state-newer-"));
  const dbPath = path.join(root, "deepseek-harness.sqlite");
  const newerVersion = STATE_SCHEMA_VERSION + 1;
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA user_version = ${newerVersion};`);
  db.close();

  assert.throws(
    () => new HarnessStore(root),
    (error: unknown) => {
      assert.equal(error instanceof HarnessError, true);
      const harnessError = error as HarnessError;
      assert.equal(harnessError.code, "state_schema_too_new");
      assert.match(harnessError.message, /Upgrade deepseek-harness/);
      return true;
    }
  );

  const verification = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = verification.prepare("PRAGMA user_version;").get() as { user_version?: number };
    assert.equal(row.user_version, newerVersion);
  } finally {
    verification.close();
  }
});
