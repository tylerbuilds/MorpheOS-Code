import test from "node:test";
import assert from "node:assert/strict";
import { buildExecutionPlan, parseManifest } from "../src/schema.js";

test("rejects live DeepSeek without approval and live flag", () => {
  const manifest = parseManifest({
    schema_version: "deepseek-harness.run.v1",
    project: "unit",
    egress_class: "non_sensitive_bulk",
    transport: "deepseek",
    model: "deepseek-v4-flash",
    concurrency: 4,
    cost_cap_usd: 0.1,
    canonical_writes: false,
    external_side_effects: false,
    items: [{ id: "a", prompt: "hello" }]
  });

  const plan = buildExecutionPlan(manifest, { mode: "execute", allowLive: false, apiKeyPresent: false });
  assert.equal(plan.ok, false);
  assert.match(plan.blockers.join(","), /live_deepseek_call_not_enabled_by_caller/);
  assert.match(plan.blockers.join(","), /approval_id_required_for_live_deepseek/);
  assert.match(plan.blockers.join(","), /deepseek_api_key_not_present/);
});

test("allows fake non-sensitive batch", () => {
  const manifest = parseManifest({
    schema_version: "deepseek-harness.run.v1",
    project: "unit",
    egress_class: "non_sensitive_bulk",
    transport: "fake",
    model: "deepseek-v4-flash",
    concurrency: 10,
    cost_cap_usd: 0.1,
    canonical_writes: false,
    external_side_effects: false,
    items: [{ id: "a", prompt: "hello" }]
  });

  const plan = buildExecutionPlan(manifest, { mode: "execute" });
  assert.equal(plan.ok, true);
  assert.equal(plan.item_count, 1);
});
