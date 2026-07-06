import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportReviewPacket, getResults, submitManifest } from "../src/runner.js";

test("submits and runs fake batch with SQLite state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-"));
  const manifest = {
    schema_version: "deepseek-harness.run.v1",
    project: "unit",
    egress_class: "non_sensitive_bulk",
    transport: "fake",
    model: "deepseek-v4-flash",
    concurrency: 3,
    cost_cap_usd: 0.1,
    canonical_writes: false,
    external_side_effects: false,
    items: Array.from({ length: 12 }, (_, index) => ({
      id: `item-${index + 1}`,
      prompt: `Prompt ${index + 1}`
    }))
  };

  const result = await submitManifest(manifest, {
    stateDir: path.join(root, ".state"),
    artifactRoot: path.join(root, "artifacts")
  }, { start: true });

  assert.equal(result.status, "completed");
  const results = getResults(result.run_id, { stateDir: path.join(root, ".state") }) as {
    items: Array<{ status: string }>;
  };
  assert.equal(results.items.length, 12);
  assert.equal(results.items.every((item) => item.status === "completed"), true);

  const packet = exportReviewPacket(result.run_id, { stateDir: path.join(root, ".state") }) as { path: string };
  assert.equal(fs.existsSync(packet.path), true);
});
