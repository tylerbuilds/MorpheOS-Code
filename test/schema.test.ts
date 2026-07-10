import test from "node:test";
import assert from "node:assert/strict";
import { approvalPacket, dispatchProposal } from "../src/runner.js";
import { buildExecutionPlan, parseManifest } from "../src/schema.js";

test("rejects live DeepSeek without signed approval, token cap and live flag", () => {
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
  assert.match(plan.blockers.join(","), /signed_approval_receipt_required_for_live_deepseek/);
  assert.match(plan.blockers.join(","), /max_tokens_required_for_live_deepseek/);
  assert.match(plan.blockers.join(","), /deepseek_api_key_not_present/);
});

test("free-form approval ids never authorise live DeepSeek", () => {
  const manifest = parseManifest({
    schema_version: "deepseek-harness.run.v1",
    project: "unit",
    egress_class: "non_sensitive_bulk",
    transport: "deepseek",
    model: "deepseek-v4-flash",
    concurrency: 4,
    cost_cap_usd: 0.1,
    approval_id: "APPROVAL-ID-GOES-HERE",
    canonical_writes: false,
    external_side_effects: false,
    items: [{ id: "a", prompt: "hello" }]
  });

  const plan = buildExecutionPlan(manifest, { mode: "execute", allowLive: true, apiKeyPresent: true });
  assert.equal(plan.ok, false);
  assert.match(plan.blockers.join(","), /signed_approval_receipt_required_for_live_deepseek/);
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

test("builds Dispatch proposal without execution authority", () => {
  const proposal = dispatchProposal({
    schema_version: "deepseek-harness.run.v1",
    project: "unit",
    egress_class: "non_sensitive_bulk",
    transport: "fake",
    model: "deepseek-v4-flash",
    concurrency: 2,
    cost_cap_usd: 0.1,
    canonical_writes: false,
    external_side_effects: false,
    items: [{ id: "a", prompt: "hello" }]
  }) as {
    schema_version: string;
    forbidden_authority: string[];
    agentOs: { executionClass: string; canonicalStateWrite: boolean };
  };

  assert.equal(proposal.schema_version, "deepseek-harness.dispatch-proposal.v1");
  assert.equal(proposal.agentOs.executionClass, "sandbox_prepare");
  assert.equal(proposal.agentOs.canonicalStateWrite, false);
  assert.equal(proposal.forbidden_authority.includes("self_approval"), true);
});

test("builds approval packet with live gates", () => {
  const packet = approvalPacket({
    schema_version: "deepseek-harness.run.v1",
    project: "unit",
    egress_class: "non_sensitive_bulk",
    transport: "deepseek",
    model: "deepseek-v4-flash",
    concurrency: 2,
    cost_cap_usd: 0.05,
    canonical_writes: false,
    external_side_effects: false,
    items: [{ id: "a", prompt: "hello" }]
  }) as {
    schema_version: string;
    approval_required: boolean;
    gates: { live_call_requires_cli_allow_live: boolean; live_call_requires_signed_receipt: boolean };
    authority: { deploy: boolean; publish: boolean };
  };

  assert.equal(packet.schema_version, "deepseek-harness.approval-packet.v1");
  assert.equal(packet.approval_required, true);
  assert.equal(packet.gates.live_call_requires_cli_allow_live, true);
  assert.equal(packet.gates.live_call_requires_signed_receipt, true);
  assert.equal(packet.authority.deploy, false);
  assert.equal(packet.authority.publish, false);
});

test("approval packet ignores placeholder strings and requires a signed receipt", () => {
  const packet = approvalPacket({
    schema_version: "deepseek-harness.run.v1",
    project: "unit",
    egress_class: "non_sensitive_bulk",
    transport: "deepseek",
    model: "deepseek-v4-flash",
    concurrency: 2,
    cost_cap_usd: 0.05,
    approval_id: "APPROVAL-ID-GOES-HERE",
    canonical_writes: false,
    external_side_effects: false,
    items: [{ id: "a", prompt: "hello" }]
  }) as {
    approval_status: string;
  };

  assert.equal(packet.approval_status, "owner_signed_receipt_required");
});
