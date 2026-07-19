// test/adversarial/test_adversarial_schema_runner.ts
// Adversarial test sweep: schema.ts, errors.ts, runner.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  HarnessError,
  usageError,
  errorExitCode,
  toErrorPayload,
} from "../../src/errors.js";

import {
  parseManifest,
  buildExecutionPlan,
  assertPlanExecutable,
  LIVE_CONCURRENCY_CAP,
  PREVIEW_CONCURRENCY_CAP,
  LIVE_COST_CAP_USD,
  runManifestSchema,
  runItemSchema,
  modelSchema,
  approvalReceiptSchema,
  failureInjectionSchema,
  type RunManifest,
  type ExecutionPlan,
} from "../../src/schema.js";

import {
  doctor,
  mcpConfig,
  mcpConfigToml,
  planManifest,
  privacyCheck,
  dispatchProposal,
  approvalPacket,
  exportApprovalPacket,
  modelComparisonPlan,
  harnessState,
  createStore,
} from "../../src/runner.js";

// ==========================================================================
// Helpers
// ==========================================================================

function baseManifest(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "deepseek-harness.run.v1",
    project: "adversarial-test",
    egress_class: "non_sensitive_bulk",
    transport: "fake" as const,
    model: "deepseek-v4-flash" as const,
    concurrency: 4,
    cost_cap_usd: 0.5,
    canonical_writes: false as const,
    external_side_effects: false as const,
    items: [{ id: "item-1", prompt: "hello world" }],
    ...overrides,
  };
}

// ==========================================================================
// schema.ts — parseManifest
// ==========================================================================

test("parseManifest: rejects null input", () => {
  assert.throws(() => parseManifest(null), HarnessError);
});

test("parseManifest: rejects undefined input", () => {
  assert.throws(() => parseManifest(undefined), HarnessError);
});

test("parseManifest: rejects empty object", () => {
  assert.throws(() => parseManifest({}), HarnessError);
});

test("parseManifest: rejects missing project", () => {
  // Typed as unknown to let the rejection happen at runtime
  assert.throws(
    () =>
      parseManifest({
        schema_version: "deepseek-harness.run.v1",
        egress_class: "non_sensitive_bulk",
        concurrency: 4,
        cost_cap_usd: 0.5,
        items: [{ id: "a", prompt: "hello" }],
      }),
    HarnessError
  );
});

test("parseManifest: rejects missing egress_class", () => {
  assert.throws(
    () =>
      parseManifest({
        schema_version: "deepseek-harness.run.v1",
        project: "adversarial",
        concurrency: 4,
        cost_cap_usd: 0.5,
        items: [{ id: "a", prompt: "hello" }],
      }),
    HarnessError
  );
});

test("parseManifest: rejects missing items", () => {
  assert.throws(
    () =>
      parseManifest({
        schema_version: "deepseek-harness.run.v1",
        project: "adversarial",
        egress_class: "non_sensitive_bulk",
        concurrency: 4,
        cost_cap_usd: 0.5,
      }),
    HarnessError
  );
});

test("parseManifest: rejects empty items array", () => {
  assert.throws(
    () =>
      parseManifest({
        schema_version: "deepseek-harness.run.v1",
        project: "adversarial",
        egress_class: "non_sensitive_bulk",
        concurrency: 4,
        cost_cap_usd: 0.5,
        items: [],
      }),
    HarnessError
  );
});

test("parseManifest: rejects invalid schema_version", () => {
  assert.throws(
    () =>
      parseManifest({
        schema_version: "deepseek-harness.run.v9",
        project: "adversarial",
        egress_class: "non_sensitive_bulk",
        concurrency: 4,
        cost_cap_usd: 0.5,
        items: [{ id: "a", prompt: "hello" }],
      }),
    HarnessError
  );
});

test("parseManifest: rejects non-object items element", () => {
  assert.throws(
    () =>
      parseManifest({
        schema_version: "deepseek-harness.run.v1",
        project: "adversarial",
        egress_class: "non_sensitive_bulk",
        concurrency: 4,
        cost_cap_usd: 0.5,
        items: ["not-an-object"],
      }),
    HarnessError
  );
});

// Boundary Values

test("parseManifest: rejects zero concurrency", () => {
  assert.throws(
    () => parseManifest(baseManifest({ concurrency: 0 })),
    HarnessError
  );
});

test("parseManifest: rejects negative concurrency", () => {
  assert.throws(
    () => parseManifest(baseManifest({ concurrency: -1 })),
    HarnessError
  );
});

test("parseManifest: rejects concurrency exceeding PREVIEW_CONCURRENCY_CAP", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({ concurrency: PREVIEW_CONCURRENCY_CAP + 1 })
      ),
    HarnessError
  );
});

test("parseManifest: accepts concurrency at PREVIEW_CONCURRENCY_CAP", () => {
  const m = parseManifest(
    baseManifest({ concurrency: PREVIEW_CONCURRENCY_CAP })
  );
  assert.equal(m.concurrency, PREVIEW_CONCURRENCY_CAP);
});

test("parseManifest: rejects zero cost_cap_usd", () => {
  assert.throws(
    () => parseManifest(baseManifest({ cost_cap_usd: 0 })),
    HarnessError
  );
});

test("parseManifest: rejects negative cost_cap_usd", () => {
  assert.throws(
    () => parseManifest(baseManifest({ cost_cap_usd: -0.01 })),
    HarnessError
  );
});

test("parseManifest: rejects cost_cap_usd exceeding max 100", () => {
  assert.throws(
    () => parseManifest(baseManifest({ cost_cap_usd: 101 })),
    HarnessError
  );
});

test("parseManifest: accepts single item", () => {
  const m = parseManifest(baseManifest());
  assert.equal(m.items.length, 1);
});

test("parseManifest: accepts 10000 items", () => {
  const items = Array.from({ length: 10000 }, (_, i) => ({
    id: `item-${i}`,
    prompt: `prompt ${i}`,
  }));
  const m = parseManifest(baseManifest({ items }));
  assert.equal(m.items.length, 10000);
});

test("parseManifest: rejects 10001 items", () => {
  const items = Array.from({ length: 10001 }, (_, i) => ({
    id: `item-${i}`,
    prompt: `prompt ${i}`,
  }));
  assert.throws(
    () => parseManifest(baseManifest({ items })),
    HarnessError
  );
});

// Type Confusion

test("parseManifest: rejects string for concurrency", () => {
  assert.throws(
    () =>
      parseManifest(baseManifest({ concurrency: "five" as unknown as number })),
    HarnessError
  );
});

test("parseManifest: rejects boolean for model", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({ model: true as unknown as typeof modelSchema })
      ),
    HarnessError
  );
});

test("parseManifest: rejects array for project", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({ project: ["arr"] as unknown as string })
      ),
    HarnessError
  );
});

test("parseManifest: rejects number for transport", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({ transport: 123 as unknown as string })
      ),
    HarnessError
  );
});

test("parseManifest: rejects array for egress_class", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({ egress_class: ["a"] as unknown as string })
      ),
    HarnessError
  );
});

test("parseManifest: rejects object for items", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({ items: { fake: true } as unknown as Array<unknown> })
      ),
    HarnessError
  );
});

test("parseManifest: rejects string for canonical_writes", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          canonical_writes: "false" as unknown as false,
        })
      ),
    HarnessError
  );
});

test("parseManifest: rejects number for response_format", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({ response_format: 42 as unknown as string })
      ),
    HarnessError
  );
});

// Injection Attacks

test("parseManifest: accepts script-like project name (string, not executed)", () => {
  // Project name is just a string; no injection vector, but verify it passes.
  const m = parseManifest(
    baseManifest({ project: "<script>alert('xss')</script>" })
  );
  assert.equal(m.project, "<script>alert('xss')</script>");
});

test("parseManifest: accepts SQL-looking item ID (hyphens allowed in ID regex)", () => {
  // The ID regex /^[A-Za-z0-9_.:-]+$/ allows hyphens, so SQL-looking IDs pass.
  // This is intentional: IDs are structural identifiers, not SQL-queried values.
  const m = parseManifest(
    baseManifest({
      items: [
        {
          id: "DROP-TABLE-users--",
          prompt: "SELECT * FROM secrets; --",
        },
      ],
    })
  );
  assert.equal(m.items[0].id, "DROP-TABLE-users--");
  assert.equal(m.items[0].prompt, "SELECT * FROM secrets; --");
});

test("parseManifest: accepts XSS-like prompt text", () => {
  const m = parseManifest(
    baseManifest({
      items: [{ id: "a", prompt: "<img src=x onerror=alert(1)>" }],
    })
  );
  assert.equal(m.items[0].prompt, "<img src=x onerror=alert(1)>");
});

test("parseManifest: rejects item ID with invalid characters", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          items: [{ id: "bad id!", prompt: "hello" }],
        })
      ),
    HarnessError
  );
});

test("parseManifest: rejects empty item ID", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          items: [{ id: "", prompt: "hello" }],
        })
      ),
    HarnessError
  );
});

// Invalid Assumptions

test("parseManifest: rejects invalid model name", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({ model: "gpt-4" as unknown as typeof modelSchema })
      ),
    HarnessError
  );
});

test("parseManifest: rejects invalid transport name", () => {
  assert.throws(
    () =>
      parseManifest(baseManifest({ transport: "openai" as unknown as "fake" })),
    HarnessError
  );
});

test("parseManifest: rejects invalid response_format", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({ response_format: "xml" as unknown as "text" })
      ),
    HarnessError
  );
});

test("parseManifest: rejects item without prompt or messages", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          items: [{ id: "orphan" }],
        })
      ),
    HarnessError
  );
});

test("parseManifest: accepts item with messages instead of prompt", () => {
  const m = parseManifest(
    baseManifest({
      items: [
        {
          id: "msg-item",
          messages: [{ role: "user" as const, content: "hello" }],
        },
      ],
    })
  );
  assert.equal(m.items[0].id, "msg-item");
});

test("parseManifest: rejects item with empty messages array", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          items: [{ id: "empty-msg", messages: [] }],
        })
      ),
    HarnessError
  );
});

test("parseManifest: rejects invalid message role", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          items: [
            {
              id: "bad-role",
              messages: [{ role: "superuser", content: "hello" }],
            },
          ],
        })
      ),
    HarnessError
  );
});

test("parseManifest: rejects empty message content", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          items: [
            {
              id: "empty-content",
              messages: [{ role: "user", content: "" }],
            },
          ],
        })
      ),
    HarnessError
  );
});

test("parseManifest: rejects temperature below 0", () => {
  assert.throws(
    () => parseManifest(baseManifest({ temperature: -0.1 })),
    HarnessError
  );
});

test("parseManifest: rejects temperature above 2", () => {
  assert.throws(
    () => parseManifest(baseManifest({ temperature: 2.1 })),
    HarnessError
  );
});

test("parseManifest: accepts temperature at boundary 0", () => {
  const m = parseManifest(baseManifest({ temperature: 0 }));
  assert.equal(m.temperature, 0);
});

test("parseManifest: accepts temperature at boundary 2", () => {
  const m = parseManifest(baseManifest({ temperature: 2 }));
  assert.equal(m.temperature, 2);
});

test("parseManifest: rejects negative max_tokens", () => {
  assert.throws(
    () => parseManifest(baseManifest({ max_tokens: -1 })),
    HarnessError
  );
});

test("parseManifest: rejects max_tokens 0", () => {
  assert.throws(
    () => parseManifest(baseManifest({ max_tokens: 0 })),
    HarnessError
  );
});

test("parseManifest: rejects max_tokens exceeding 384000", () => {
  assert.throws(
    () => parseManifest(baseManifest({ max_tokens: 384001 })),
    HarnessError
  );
});

test("parseManifest: accepts max_tokens at 384000", () => {
  const m = parseManifest(baseManifest({ max_tokens: 384000 }));
  assert.equal(m.max_tokens, 384000);
});

// --- failure_injection sub-schema ---

test("parseManifest: rejects failure_injection without fail_item_ids or fail_every_n", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({ failure_injection: { error_message: "boom" } })
      ),
    HarnessError
  );
});

test("parseManifest: accepts failure_injection with fail_every_n", () => {
  const m = parseManifest(
    baseManifest({ failure_injection: { fail_every_n: 2 } })
  );
  assert.equal(m.failure_injection?.fail_every_n, 2);
});

test("parseManifest: accepts failure_injection with fail_item_ids", () => {
  const m = parseManifest(
    baseManifest({
      failure_injection: { fail_item_ids: ["a", "b"] },
    })
  );
  assert.deepEqual(m.failure_injection?.fail_item_ids, ["a", "b"]);
});

test("parseManifest: rejects failure_injection with empty fail_item_ids", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({ failure_injection: { fail_item_ids: [] } })
      ),
    HarnessError
  );
});

// --- runManifestSchema (direct) ---

test("runManifestSchema: safeParse returns error for null", () => {
  const result = runManifestSchema.safeParse(null);
  assert.equal(result.success, false);
});

test("runManifestSchema: safeParse returns error for string", () => {
  const result = runManifestSchema.safeParse("hello");
  assert.equal(result.success, false);
});

test("runManifestSchema: safeParse returns error for array", () => {
  const result = runManifestSchema.safeParse([1, 2, 3]);
  assert.equal(result.success, false);
});

test("runManifestSchema: safeParse error contains field-level details", () => {
  const result = runManifestSchema.safeParse({});
  assert.equal(result.success, false);
  if (!result.success) {
    const issues = result.error.issues;
    assert.ok(Array.isArray(issues));
    assert.ok(issues.length > 0);
  }
});

// ==========================================================================
// schema.ts — buildExecutionPlan
// ==========================================================================

test("buildExecutionPlan: valid fake manifest produces ok plan", () => {
  const manifest = parseManifest(baseManifest());
  const plan = buildExecutionPlan(manifest, { mode: "plan" });
  assert.equal(plan.ok, true);
  assert.equal(plan.transport, "fake");
  assert.equal(plan.item_count, 1);
  assert.deepEqual(plan.blockers, []);
});

test("buildExecutionPlan: dry-run transport adds warning", () => {
  const manifest = parseManifest(
    baseManifest({ transport: "dry-run" as const })
  );
  const plan = buildExecutionPlan(manifest, { mode: "plan" });
  assert.equal(plan.ok, true);
  const hasWarning = plan.warnings.some((w) =>
    w.includes("deepseek_request_shape_only")
  );
  assert.equal(hasWarning, true);
});

test("buildExecutionPlan: deepseek transport without allowLive blocks", () => {
  const manifest = parseManifest(
    baseManifest({ transport: "deepseek" as const })
  );
  const plan = buildExecutionPlan(manifest, { mode: "plan" });
  assert.equal(plan.ok, false);
  assert.ok(plan.blockers.includes("live_deepseek_call_not_enabled_by_caller"));
});

test("buildExecutionPlan: deepseek transport blocks without API key", () => {
  const manifest = parseManifest(
    baseManifest({ transport: "deepseek" as const })
  );
  const plan = buildExecutionPlan(manifest, {
    mode: "plan",
    allowLive: true,
    apiKeyPresent: false,
  });
  assert.equal(plan.ok, false);
  assert.ok(plan.blockers.includes("deepseek_api_key_not_present"));
});

test("buildExecutionPlan: json_object response_format adds warning", () => {
  const manifest = parseManifest(
    baseManifest({ response_format: "json_object" as const })
  );
  const plan = buildExecutionPlan(manifest, { mode: "plan" });
  const hasWarning = plan.warnings.some((w) =>
    w.includes("json_output_requires_prompt_instruction")
  );
  assert.equal(hasWarning, true);
});

test("buildExecutionPlan: concurrency exceeding LIVE cap blocks for deepseek", () => {
  const manifest = parseManifest(
    baseManifest({ transport: "deepseek" as const, concurrency: LIVE_CONCURRENCY_CAP + 1 })
  );
  const plan = buildExecutionPlan(manifest, {
    mode: "plan",
    allowLive: true,
    apiKeyPresent: true,
  });
  assert.equal(plan.ok, false);
  assert.ok(
    plan.blockers.some((b) => b.includes(`live_concurrency_cap_exceeded`))
  );
});

test("buildExecutionPlan: deepseek blocks without max_tokens", () => {
  const manifest = parseManifest(
    baseManifest({ transport: "deepseek" as const })
  );
  const plan = buildExecutionPlan(manifest, {
    mode: "plan",
    allowLive: true,
    apiKeyPresent: true,
  });
  assert.equal(plan.ok, false);
  assert.ok(
    plan.blockers.includes("max_tokens_required_for_live_deepseek")
  );
});

test("buildExecutionPlan: canonical_writes=true rejected at schema level", () => {
  // canonical_writes uses z.literal(false), so any truthy value is rejected by Zod
  assert.throws(
    () =>
      parseManifest(
        baseManifest({ canonical_writes: true as unknown as false })
      ),
    HarnessError
  );
});

test("buildExecutionPlan: works with large item count", () => {
  const items = Array.from({ length: 500 }, (_, i) => ({
    id: `item-${i}`,
    prompt: `prompt ${i}`,
  }));
  const manifest = parseManifest(baseManifest({ items }));
  const plan = buildExecutionPlan(manifest, { mode: "plan" });
  assert.equal(plan.ok, true);
  assert.equal(plan.item_count, 500);
});

test("buildExecutionPlan: plan has expected fields", () => {
  const manifest = parseManifest(baseManifest());
  const plan = buildExecutionPlan(manifest, { mode: "queued" });
  assert.equal(typeof plan.ok, "boolean");
  assert.equal(plan.mode, "queued");
  assert.equal(typeof plan.project, "string");
  assert.equal(typeof plan.transport, "string");
  assert.equal(typeof plan.model, "string");
  assert.equal(typeof plan.item_count, "number");
  assert.equal(typeof plan.concurrency, "number");
  assert.equal(typeof plan.cost_cap_usd, "number");
  assert.equal(typeof plan.live_call_requested, "boolean");
  assert.ok(Array.isArray(plan.blockers));
  assert.ok(Array.isArray(plan.warnings));
  assert.equal(typeof plan.privacy.schema_version, "string");
  assert.equal(typeof plan.estimated_usage.schema_version, "string");
});

// ==========================================================================
// schema.ts — assertPlanExecutable
// ==========================================================================

test("assertPlanExecutable: does not throw for ok plan", () => {
  const manifest = parseManifest(baseManifest());
  const plan = buildExecutionPlan(manifest, { mode: "plan" });
  assert.doesNotThrow(() => assertPlanExecutable(plan));
});

test("assertPlanExecutable: throws for blocked plan", () => {
  const manifest = parseManifest(
    baseManifest({ transport: "deepseek" as const })
  );
  const plan = buildExecutionPlan(manifest, { mode: "plan" });
  assert.throws(() => assertPlanExecutable(plan), HarnessError);
});

// ==========================================================================
// schema.ts — modelSchema
// ==========================================================================

test("modelSchema: accepts deepseek-v4-flash", () => {
  assert.doesNotThrow(() => modelSchema.parse("deepseek-v4-flash"));
});

test("modelSchema: accepts deepseek-v4-pro", () => {
  assert.doesNotThrow(() => modelSchema.parse("deepseek-v4-pro"));
});

test("modelSchema: rejects unknown model", () => {
  assert.throws(() => modelSchema.parse("gpt-4"));
});

test("modelSchema: rejects empty string", () => {
  assert.throws(() => modelSchema.parse(""));
});

test("modelSchema: rejects null", () => {
  assert.throws(() => modelSchema.parse(null));
});

// ==========================================================================
// errors.ts — HarnessError
// ==========================================================================

test("HarnessError: creates valid error with all fields", () => {
  const err = new HarnessError("test_code", "test message", { detail: 1 }, 2);
  assert.equal(err.code, "test_code");
  assert.equal(err.message, "test message");
  assert.deepEqual(err.details, { detail: 1 });
  assert.equal(err.exitCode, 2);
  assert.ok(err instanceof Error);
  assert.ok(err instanceof HarnessError);
});

test("HarnessError: default exitCode is 1", () => {
  const err = new HarnessError("test_code", "msg");
  assert.equal(err.exitCode, 1);
});

test("HarnessError: default details is undefined", () => {
  const err = new HarnessError("test_code", "msg");
  assert.equal(err.details, undefined);
});

test("HarnessError: empty code string", () => {
  const err = new HarnessError("", "message");
  assert.equal(err.code, "");
});

test("HarnessError: very long code string", () => {
  const longCode = "X".repeat(500);
  const err = new HarnessError(longCode, "msg");
  assert.equal(err.code.length, 500);
  assert.equal(err.code, longCode);
});

test("HarnessError: empty message string", () => {
  const err = new HarnessError("code", "");
  assert.equal(err.message, "");
});

test("HarnessError: null details", () => {
  const err = new HarnessError("code", "msg", null);
  assert.equal(err.details, null);
});

test("HarnessError: undefined exitCode defaults to 1", () => {
  const err = new HarnessError("code", "msg", undefined, undefined);
  assert.equal(err.exitCode, 1);
});

// ==========================================================================
// errors.ts — usageError
// ==========================================================================

test("usageError: creates HarnessError with exitCode 2", () => {
  const err = usageError("invalid_input", "Bad input", "Check the docs");
  assert.ok(err instanceof HarnessError);
  assert.equal(err.code, "invalid_input");
  assert.equal(err.exitCode, 2);
  const d = err.details as Record<string, unknown>;
  assert.equal(d.recoverable, true);
  assert.equal(d.suggestion, "Check the docs");
  assert.deepEqual(d.next_actions, ["Check the docs"]);
});

test("usageError: deduplicates next_actions", () => {
  const err = usageError("bad", "msg", "fix it", ["fix it", "fix it", "also"]);
  const d = err.details as Record<string, unknown>;
  const actions = d.next_actions as string[];
  assert.deepEqual(actions, ["fix it", "also"]);
});

test("usageError: empty code", () => {
  const err = usageError("", "msg", "suggestion");
  assert.equal(err.code, "");
  assert.equal(err.exitCode, 2);
});

// ==========================================================================
// errors.ts — errorExitCode
// ==========================================================================

test("errorExitCode: returns 1 for non-Error types", () => {
  assert.equal(errorExitCode("string error"), 1);
  assert.equal(errorExitCode(42), 1);
  assert.equal(errorExitCode(null), 1);
  assert.equal(errorExitCode(undefined), 1);
  assert.equal(errorExitCode({}), 1);
});

test("errorExitCode: returns 1 for standard Error", () => {
  assert.equal(errorExitCode(new Error("plain")), 1);
});

test("errorExitCode: returns 3 for blocked code", () => {
  const err = new HarnessError("blocked_by_safety", "blocked");
  assert.equal(errorExitCode(err), 3);
});

test("errorExitCode: returns 3 for authority code", () => {
  const err = new HarnessError("authority_missing", "auth");
  assert.equal(errorExitCode(err), 3);
});

test("errorExitCode: returns 3 for approval_receipt code", () => {
  const err = new HarnessError("approval_receipt_invalid", "bad receipt");
  assert.equal(errorExitCode(err), 3);
});

test("errorExitCode: returns 3 for budget_exhausted code", () => {
  const err = new HarnessError("daily_budget_exhausted", "out");
  assert.equal(errorExitCode(err), 3);
});

test("errorExitCode: returns 3 for approval_receipt_replayed code", () => {
  const err = new HarnessError("approval_receipt_replayed", "replayed");
  assert.equal(errorExitCode(err), 3);
});

test("errorExitCode: returns 2 for invalid_ prefix", () => {
  const err = new HarnessError("invalid_manifest", "bad");
  assert.equal(errorExitCode(err), 2);
});

test("errorExitCode: returns 2 for missing_ prefix", () => {
  const err = new HarnessError("missing_field", "gone");
  assert.equal(errorExitCode(err), 2);
});

test("errorExitCode: returns 2 for _not_found suffix", () => {
  const err = new HarnessError("run_not_found", "gone");
  assert.equal(errorExitCode(err), 2);
});

test("errorExitCode: returns 2 for _required suffix", () => {
  const err = new HarnessError("field_required", "needed");
  assert.equal(errorExitCode(err), 2);
});

test("errorExitCode: returns custom exitCode when not 1", () => {
  const err = new HarnessError("weird_code", "msg", undefined, 5);
  assert.equal(errorExitCode(err), 5);
});

test("errorExitCode: returns 1 for unknown code pattern", () => {
  const err = new HarnessError("general_failure", "msg");
  assert.equal(errorExitCode(err), 1);
});

test("errorExitCode: handles Error with circular references gracefully", () => {
  // Not applicable: errorExitCode doesn't serialize, just checks instanceof
  const obj: Record<string, unknown> = {};
  obj.self = obj;
  assert.equal(errorExitCode(obj), 1);
});

// ==========================================================================
// errors.ts — toErrorPayload
// ==========================================================================

test("toErrorPayload: produces expected shape for HarnessError", () => {
  const err = new HarnessError("test_code", "test message", { key: "val" });
  const payload = toErrorPayload(err);
  assert.deepEqual(payload, {
    ok: false,
    code: "test_code",
    message: "test message",
    details: { key: "val" },
  });
});

test("toErrorPayload: null details become null", () => {
  const err = new HarnessError("test_code", "msg", null);
  const payload = toErrorPayload(err);
  assert.deepEqual(payload, {
    ok: false,
    code: "test_code",
    message: "msg",
    details: null,
  });
});

test("toErrorPayload: handles standard Error", () => {
  const err = new Error("plain error");
  const payload = toErrorPayload(err);
  assert.deepEqual(payload, {
    ok: false,
    code: "unexpected_error",
    message: "plain error",
  });
});

test("toErrorPayload: handles string error", () => {
  const payload = toErrorPayload("string error");
  assert.deepEqual(payload, {
    ok: false,
    code: "unexpected_error",
    message: "string error",
  });
});

test("toErrorPayload: handles null", () => {
  const payload = toErrorPayload(null);
  assert.deepEqual(payload, {
    ok: false,
    code: "unexpected_error",
    message: "null",
  });
});

test("toErrorPayload: handles undefined", () => {
  const payload = toErrorPayload(undefined);
  assert.deepEqual(payload, {
    ok: false,
    code: "unexpected_error",
    message: "undefined",
  });
});

test("toErrorPayload: handles number", () => {
  const payload = toErrorPayload(42);
  assert.deepEqual(payload, {
    ok: false,
    code: "unexpected_error",
    message: "42",
  });
});

test("toErrorPayload: handles object (non-Error)", () => {
  const payload = toErrorPayload({ reason: "fail" });
  assert.deepEqual(payload, {
    ok: false,
    code: "unexpected_error",
    message: "[object Object]",
  });
});

// ==========================================================================
// runner.ts — doctor
// ==========================================================================

test("doctor: returns expected fields", () => {
  const result = doctor();
  assert.equal(result.ok, true);
  assert.equal(typeof result.version, "string");
  assert.equal(typeof result.node, "string");
  assert.equal(typeof result.state_dir, "string");
  assert.equal(typeof result.deepseek_api_key_present, "boolean");
  assert.equal(typeof result.live_concurrency_cap, "number");
  assert.equal(typeof result.canonical_state_write, "boolean");
  assert.equal(typeof result.external_side_effects, "boolean");
});

test("doctor: returns consistent field types", () => {
  const result = doctor();
  assert.equal(typeof result.state_schema, "object");
  const stateSchema = result.state_schema as Record<string, unknown>;
  assert.equal(typeof stateSchema.current, "number");
  assert.equal(typeof stateSchema.supported, "number");
  assert.equal(typeof stateSchema.compatible, "boolean");
  assert.equal(typeof result.cli, "object");
  const cli = result.cli as Record<string, unknown>;
  assert.equal(typeof cli.source_entrypoint, "string");
  assert.equal(typeof cli.mcp_entrypoint, "string");
  // entrypoints should be absolute
  assert.ok((cli.source_entrypoint as string).startsWith("/"));
  assert.ok((cli.mcp_entrypoint as string).startsWith("/"));
});

test("doctor: returns consistent state dir path", () => {
  const result1 = doctor();
  const result2 = doctor();
  assert.equal(result1.state_dir, result2.state_dir);
});

// ==========================================================================
// runner.ts — mcpConfig / mcpConfigToml
// ==========================================================================

test("mcpConfig: default config uses process.execPath", () => {
  const config = mcpConfig() as {
    mcpServers: { "deepseek-harness": { command: string; args: string[] } };
  };
  assert.equal(
    config.mcpServers["deepseek-harness"].command,
    process.execPath
  );
});

test("mcpConfig: custom command has empty args", () => {
  const config = mcpConfig({ command: "/usr/bin/node" }) as {
    mcpServers: { "deepseek-harness": { command: string; args: string[] } };
  };
  assert.equal(
    config.mcpServers["deepseek-harness"].command,
    "/usr/bin/node"
  );
  assert.deepEqual(config.mcpServers["deepseek-harness"].args, []);
});

test("mcpConfigToml: generates valid TOML", () => {
  const toml = mcpConfigToml({ command: "/bin/node", stateDir: "/tmp/state", artifactDir: "/tmp/artifacts" });
  assert.ok(toml.includes("[mcp_servers.deepseek-harness]"));
  assert.ok(toml.includes("[mcp_servers.deepseek-harness.env]"));
  assert.ok(toml.includes("DEEPSEEK_HARNESS_STATE_DIR"));
  assert.ok(toml.includes("DEEPSEEK_HARNESS_ARTIFACT_DIR"));
  // No API key leaked
  assert.equal(toml.includes("DEEPSEEK_API_KEY"), false);
});

test("mcpConfig: no API key in env", () => {
  const config = mcpConfig() as {
    mcpServers: {
      "deepseek-harness": { env: Record<string, string> };
    };
  };
  const env = config.mcpServers["deepseek-harness"].env;
  assert.equal("DEEPSEEK_API_KEY" in env, false);
});

// ==========================================================================
// runner.ts — planManifest
// ==========================================================================

test("planManifest: valid manifest returns ok plan", () => {
  const result = planManifest(baseManifest());
  assert.equal(result.ok, true);
  const plan = result.plan as ExecutionPlan;
  assert.equal(plan.ok, true);
  assert.equal(plan.transport, "fake");
});

test("planManifest: deepseek without allowLive returns blocked", () => {
  const result = planManifest(
    baseManifest({ transport: "deepseek" as const })
  );
  const plan = result.plan as ExecutionPlan;
  assert.equal(plan.ok, false);
  assert.ok(plan.blockers.includes("live_deepseek_call_not_enabled_by_caller"));
});

test("planManifest: deepseek with allowLive but no key returns blocked", () => {
  const result = planManifest(
    baseManifest({ transport: "deepseek" as const }),
    { allowLive: true }
  );
  const plan = result.plan as ExecutionPlan;
  assert.equal(plan.ok, false);
  assert.ok(plan.blockers.includes("deepseek_api_key_not_present"));
});

test("planManifest: rejects null input", () => {
  assert.throws(() => planManifest(null), HarnessError);
});

test("planManifest: rejects undefined input", () => {
  assert.throws(() => planManifest(undefined), HarnessError);
});

test("planManifest: rejects string input", () => {
  assert.throws(() => planManifest("not-a-manifest"), HarnessError);
});

test("planManifest: rejects array input", () => {
  assert.throws(() => planManifest([]), HarnessError);
});

test("planManifest: rejects empty object", () => {
  assert.throws(() => planManifest({}), HarnessError);
});

// ==========================================================================
// runner.ts — privacyCheck
// ==========================================================================

test("privacyCheck: non-sensitive manifest returns ok", () => {
  const result = privacyCheck(baseManifest());
  assert.equal(typeof result.ok, "boolean");
  assert.equal(typeof result.privacy, "object");
});

test("privacyCheck: rejects null input", () => {
  assert.throws(() => privacyCheck(null), HarnessError);
});

test("privacyCheck: returns valid privacy report structure", () => {
  const result = privacyCheck(baseManifest());
  const privacy = result.privacy as Record<string, unknown>;
  assert.equal(
    privacy.schema_version,
    "deepseek-harness.privacy-report.v1"
  );
  assert.equal(typeof privacy.recommended_egress_class, "string");
  assert.equal(typeof privacy.external_deepseek_allowed, "boolean");
  assert.ok(Array.isArray(privacy.findings));
});

test("privacyCheck: manifesto-egress_class matches input", () => {
  const result = privacyCheck(
    baseManifest({ egress_class: "personal_sensitive" as const })
  );
  assert.equal(result.manifest_egress_class, "personal_sensitive");
});

// ==========================================================================
// runner.ts — dispatchProposal
// ==========================================================================

test("dispatchProposal: returns expected schema", () => {
  const result = dispatchProposal(baseManifest()) as Record<string, unknown>;
  assert.equal(result.schema_version, "deepseek-harness.dispatch-proposal.v1");
  assert.equal(result.source, "deepseek-harness");
  assert.equal(result.selected_action, "prepare_deepseek_batch");
  assert.equal(result.selected_worker, "deepseek-harness");
});

test("dispatchProposal: fake transport does not require approval", () => {
  const result = dispatchProposal(baseManifest()) as Record<string, unknown>;
  assert.equal(result.approval_required, false);
  assert.equal(result.receipt_required, false);
});

test("dispatchProposal: deepseek transport requires approval", () => {
  const result = dispatchProposal(
    baseManifest({ transport: "deepseek" as const })
  ) as Record<string, unknown>;
  assert.equal(result.approval_required, true);
  assert.equal(result.receipt_required, true);
});

test("dispatchProposal: forbidden_authority includes self_approval", () => {
  const result = dispatchProposal(baseManifest()) as {
    forbidden_authority: string[];
  };
  assert.ok(result.forbidden_authority.includes("self_approval"));
  assert.ok(result.forbidden_authority.includes("deploy"));
});

test("dispatchProposal: agentOs has correct fields", () => {
  const result = dispatchProposal(baseManifest()) as {
    agentOs: Record<string, unknown>;
  };
  assert.equal(result.agentOs.executionClass, "sandbox_prepare");
  assert.equal(result.agentOs.canonicalStateWrite, false);
  assert.equal(result.agentOs.commandCentreStateWrite, false);
});

test("dispatchProposal: rejects null input", () => {
  assert.throws(() => dispatchProposal(null), HarnessError);
});

// ==========================================================================
// runner.ts — approvalPacket
// ==========================================================================

test("approvalPacket: returns expected schema", () => {
  const result = approvalPacket(baseManifest()) as Record<string, unknown>;
  assert.equal(
    result.schema_version,
    "deepseek-harness.approval-packet.v1"
  );
  assert.equal(typeof result.generated_at, "string");
});

test("approvalPacket: deepseek transport requires approval", () => {
  const result = approvalPacket(
    baseManifest({ transport: "deepseek" as const })
  ) as Record<string, unknown>;
  assert.equal(result.approval_required, true);
});

test("approvalPacket: fake transport does not require approval", () => {
  const result = approvalPacket(baseManifest()) as Record<string, unknown>;
  assert.equal(result.approval_required, false);
});

test("approvalPacket: includes both plan variants", () => {
  const result = approvalPacket(baseManifest()) as Record<string, unknown>;
  assert.equal(typeof result.plan_without_live_flag, "object");
  assert.equal(typeof result.plan_with_live_flag, "object");
  assert.equal(typeof result.gates, "object");
});

test("approvalPacket: deepseek transport shows owner_signed_receipt_required", () => {
  const result = approvalPacket(
    baseManifest({ transport: "deepseek" as const })
  ) as Record<string, unknown>;
  assert.equal(result.approval_status, "owner_signed_receipt_required");
});

test("approvalPacket: rejects null input", () => {
  assert.throws(() => approvalPacket(null), HarnessError);
});

// ==========================================================================
// runner.ts — exportApprovalPacket
// ==========================================================================

test("exportApprovalPacket: writes file to artifact root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-adv-"));
  try {
    const output = path.join(root, "approval.json");
    const result = exportApprovalPacket(baseManifest(), { artifactRoot: root }, { output }) as { path: string; ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(result.path, output);
    assert.equal(fs.existsSync(output), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exportApprovalPacket: default output path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-adv-"));
  try {
    const result = exportApprovalPacket(baseManifest(), { artifactRoot: root }) as { path: string; ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(result.path), true);
    // path should be inside artifact root
    assert.ok(result.path.startsWith(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ==========================================================================
// runner.ts — modelComparisonPlan
// ==========================================================================

test("modelComparisonPlan: builds candidates for both models", () => {
  const result = modelComparisonPlan(baseManifest()) as {
    ok: boolean;
    report: { candidates: Array<{ model: string }> };
  };
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.report.candidates));
  assert.equal(result.report.candidates.length, 2);
  const models = result.report.candidates.map((c) => c.model);
  assert.ok(models.includes("deepseek-v4-flash"));
  assert.ok(models.includes("deepseek-v4-pro"));
});

test("modelComparisonPlan: all candidates use dry-run transport", () => {
  const result = modelComparisonPlan(baseManifest()) as {
    report: { candidates: Array<{ manifest: { transport: string } }> };
  };
  for (const candidate of result.report.candidates) {
    assert.equal(candidate.manifest.transport, "dry-run");
  }
});

test("modelComparisonPlan: accepts custom models list", () => {
  const result = modelComparisonPlan(baseManifest(), {
    models: ["deepseek-v4-flash"],
  }) as {
    report: { candidates: Array<{ model: string }> };
  };
  assert.equal(result.report.candidates.length, 1);
  assert.equal(result.report.candidates[0].model, "deepseek-v4-flash");
});

test("modelComparisonPlan: appends model suffix to project names", () => {
  const result = modelComparisonPlan(baseManifest()) as {
    report: { candidates: Array<{ manifest: { project: string } }> };
  };
  assert.ok(
    result.report.candidates.some((c) =>
      c.manifest.project.endsWith("deepseek-v4-flash")
    )
  );
  assert.ok(
    result.report.candidates.some((c) =>
      c.manifest.project.endsWith("deepseek-v4-pro")
    )
  );
});

// ==========================================================================
// runner.ts — createStore
// ==========================================================================

test("createStore: creates store with default state dir", () => {
  const store = createStore();
  try {
    assert.equal(typeof store.stateDir, "string");
    assert.equal(typeof store.dbPath, "string");
  } finally {
    store.close();
  }
});

test("createStore: creates store with custom state dir", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-adv-"));
  try {
    const store = createStore({ stateDir: path.join(root, ".state") });
    try {
      assert.ok(store.stateDir.includes(root));
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ==========================================================================
// runner.ts — Integration: planManifest + submission via fake transport
// ==========================================================================

test("integration: fake manifest plans, submits, and runs locally", async () => {
  const { submitManifest, getResults, getStatus } = await import(
    "../../src/runner.js"
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-adv-"));
  try {
    const stateDir = path.join(root, ".state");
    const artifactRoot = path.join(root, "artifacts");

    const manifest = baseManifest({
      items: [
        { id: "a", prompt: "hello" },
        { id: "b", prompt: "world" },
        { id: "c", prompt: "test" },
      ],
      concurrency: 2,
    });

    const result = await submitManifest(
      manifest,
      { stateDir, artifactRoot },
      { start: true }
    );

    assert.equal(result.ok, true);
    assert.equal(typeof result.run_id, "string");
    assert.equal(result.status, "completed");

    const results = getResults(result.run_id, { stateDir }) as {
      items: Array<{ status: string; item_id: string }>;
    };
    assert.equal(results.items.length, 3);
    assert.ok(results.items.every((item) => item.status === "completed"));

    const status = getStatus(result.run_id, { stateDir }) as {
      ok: boolean;
      summary: Record<string, unknown>;
    };
    assert.equal(status.ok, true);
    assert.equal(status.summary.status, "completed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("integration: dry-run transport runs locally", async () => {
  const { submitManifest } = await import("../../src/runner.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-adv-"));
  try {
    const result = await submitManifest(
      baseManifest({
        transport: "dry-run" as const,
        items: [{ id: "x", prompt: "dry run test" }],
      }),
      {
        stateDir: path.join(root, ".state"),
        artifactRoot: path.join(root, "artifacts"),
      },
      { start: true }
    );
    assert.equal(result.status, "completed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("integration: submit without start leaves queued status", async () => {
  const { submitManifest } = await import("../../src/runner.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-adv-"));
  try {
    const result = await submitManifest(
      baseManifest(),
      {
        stateDir: path.join(root, ".state"),
        artifactRoot: path.join(root, "artifacts"),
      },
      { start: false }
    );
    assert.equal(result.ok, true);
    assert.equal(result.status, "queued");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("integration: deepseek transport blocked during submit", async () => {
  const { submitManifest } = await import("../../src/runner.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-adv-"));
  try {
    await assert.rejects(
      () =>
        submitManifest(
          baseManifest({ transport: "deepseek" as const }),
          {
            stateDir: path.join(root, ".state"),
            artifactRoot: path.join(root, "artifacts"),
          },
          { start: true }
        ),
      HarnessError
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("integration: cancel run works", async () => {
  const { submitManifest, cancelRun } = await import(
    "../../src/runner.js"
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-adv-"));
  try {
    const stateDir = path.join(root, ".state");
    const result = await submitManifest(
      baseManifest(),
      { stateDir, artifactRoot: path.join(root, "artifacts") },
      { start: false }
    );
    const cancelled = cancelRun(result.run_id, { stateDir }) as {
      ok: boolean;
      status: string;
    };
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.status, "cancelled");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ==========================================================================
// runner.ts — harnessState / exportHarnessState
// ==========================================================================

test("harnessState: returns expected fields", () => {
  const result = harnessState() as Record<string, unknown>;
  assert.equal(result.schema_version, "deepseek-harness.state.v1");
  assert.equal(typeof result.generated_at, "string");
  assert.equal(typeof result.authority, "object");
  assert.equal(typeof result.environment, "object");
  assert.ok(Array.isArray(result.runs));
});

// ==========================================================================
// runner.ts — mcpConfig with all profiles
// ==========================================================================

test("mcpConfig: respects profile option", () => {
  const configCore = mcpConfig({ profile: "core" as const }) as {
    mcpServers: { "deepseek-harness": { env: Record<string, string> } };
  };
  assert.equal(
    configCore.mcpServers["deepseek-harness"].env
      .DEEPSEEK_HARNESS_MCP_PROFILE,
    "core"
  );

  const configFull = mcpConfig({ profile: "full" as const }) as {
    mcpServers: { "deepseek-harness": { env: Record<string, string> } };
  };
  assert.equal(
    configFull.mcpServers["deepseek-harness"].env
      .DEEPSEEK_HARNESS_MCP_PROFILE,
    "full"
  );
});

// ==========================================================================
// schema.ts — approvalReceiptSchema edge cases
// ==========================================================================

test("approvalReceiptSchema: rejects receipt with wrong schema_version", () => {
  const receipt = {
    schema_version: "wrong-version",
    receipt_id: "test-receipt-id-12345",
    status: "approved",
    issuer: "owner",
    issued_at: "2025-01-01T00:00:00.000Z",
    expires_at: "2025-12-31T23:59:59.000Z",
    nonce: "abcdefghijklmnopqr",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    network_payload_sha256: "a".repeat(64),
    egress_class: "non_sensitive_bulk",
    max_items: 100,
    max_concurrency: 10,
    max_cost_usd: 3,
    daily_cost_cap_usd: 5,
    rate_snapshot: {
      id: "rates-v1",
      input_usd_per_million: 0.5,
      output_usd_per_million: 1.05,
    },
    signature_base64: "abcdefghijklmnopqr",
  };
  assert.throws(() => approvalReceiptSchema.parse(receipt));
});

// ==========================================================================
// schema.ts — parseManifest additional adversarial
// ==========================================================================

test("parseManifest: rejects object with extra unknown keys (Zod strips by default)", () => {
  // Zod's default behavior with .object() strips unknown keys, which means
  // parseManifest will succeed even with extra keys. This documents the behavior.
  const m = parseManifest(
    baseManifest({ extra_evil_key: "malicious" as unknown as undefined })
  );
  // The manifest should still have the core fields intact
  assert.equal(m.project, "adversarial-test");
  // Extra key should NOT appear (Zod strips unknowns by default)
  assert.equal((m as Record<string, unknown>).extra_evil_key, undefined);
});

test("parseManifest: rejects item with missing id", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          items: [{ prompt: "no id" } as unknown as typeof baseManifest],
        })
      ),
    HarnessError
  );
});

test("parseManifest: accepts optional run_id", () => {
  const m = parseManifest(
    baseManifest({ run_id: "my-custom-run-id" })
  );
  assert.equal(m.run_id, "my-custom-run-id");
});

test("parseManifest: accepts optional description", () => {
  const m = parseManifest(
    baseManifest({ description: "test description" })
  );
  assert.equal(m.description, "test description");
});

test("parseManifest: accepts thinking with reasoning_effort", () => {
  const m = parseManifest(
    baseManifest({
      thinking: { type: "enabled" as const, reasoning_effort: "high" as const },
    })
  );
  assert.equal(m.thinking.type, "enabled");
  assert.equal(m.thinking.reasoning_effort, "high");
});

test("parseManifest: defaults thinking when omitted", () => {
  const m = parseManifest(baseManifest());
  assert.equal(m.thinking.type, "enabled");
});

// ==========================================================================
// errors.ts — HarnessError name property
// ==========================================================================

test("HarnessError: name is 'HarnessError'", () => {
  const err = new HarnessError("code", "msg");
  assert.equal(err.name, "HarnessError");
});

test("HarnessError: stack trace includes HarnessError", () => {
  const err = new HarnessError("code", "msg");
  assert.ok(err.stack?.includes("HarnessError"));
});

// ==========================================================================
// errors.ts — errorExitCode boundary tests
// ==========================================================================

test("errorExitCode: HarnessError with exitCode 0 returns 0", () => {
  const err = new HarnessError("any_code", "msg", undefined, 0);
  assert.equal(errorExitCode(err), 0);
});

test("errorExitCode: HarnessError with exitCode -1 returns -1", () => {
  const err = new HarnessError("any_code", "msg", undefined, -1);
  assert.equal(errorExitCode(err), -1);
});

// ==========================================================================
// runner.ts — planManifest boundary with extreme values
// ==========================================================================

test("planManifest: handles edge case concurrency=1", () => {
  const result = planManifest(baseManifest({ concurrency: 1 }));
  assert.equal(result.ok, true);
});

test("planManifest: handles edge case cost_cap_usd=0.001", () => {
  // Very small but positive - should pass schema validation
  const m = parseManifest(baseManifest({ cost_cap_usd: 0.001 }));
  assert.equal(m.cost_cap_usd, 0.001);
});

test("planManifest: handles many items efficiently", () => {
  const items = Array.from({ length: 1000 }, (_, i) => ({
    id: `item-${i}`,
    prompt: `prompt ${i}`,
  }));
  const started = performance.now();
  const m = parseManifest(baseManifest({ items }));
  const elapsed = performance.now() - started;
  assert.equal(m.items.length, 1000);
  // Should parse quickly (< 500ms)
  assert.ok(elapsed < 500, `Parsing took ${elapsed}ms, expected < 500ms`);
});

// ==========================================================================
// runner.ts — mcpConfigToml edge cases
// ==========================================================================

test("mcpConfigToml: handles paths with special characters", () => {
  const toml = mcpConfigToml({
    command: "/path/with spaces/node",
    stateDir: "/tmp/state (1)",
    artifactDir: "/tmp/artifacts",
  });
  assert.ok(toml.includes('"/path/with spaces/node"'));
});

// ==========================================================================
// schema.ts — failureInjectionSchema edge cases
// ==========================================================================

test("parseManifest: failure_injection with negative fail_every_n rejected", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({ failure_injection: { fail_every_n: -1 } })
      ),
    HarnessError
  );
});

test("parseManifest: failure_injection with zero fail_every_n rejected", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({ failure_injection: { fail_every_n: 0 } })
      ),
    HarnessError
  );
});

test("parseManifest: failure_injection error_message too long", () => {
  assert.throws(
    () =>
      parseManifest(
        baseManifest({
          failure_injection: {
            fail_every_n: 1,
            error_message: "X".repeat(501),
          },
        })
      ),
    HarnessError
  );
});

// ==========================================================================
// runner.ts — dispatchProposal deep structure checks
// ==========================================================================

test("dispatchProposal: contains valid evidence_target", () => {
  const result = dispatchProposal(
    baseManifest({ run_id: "test-run-123" })
  ) as { evidence_target: { artifact_dir: string | null; review_packet: string | null } };
  assert.equal(result.evidence_target.review_packet, "test-run-123/review-packet.json");
});

// ==========================================================================
// runner.ts — privacyCheck sensitive egress
// ==========================================================================

test("privacyCheck: blocks external deepseek with sensitive egress", () => {
  const result = privacyCheck(
    baseManifest({
      transport: "deepseek" as const,
      egress_class: "secrets_or_credentials" as const,
    })
  );
  // Deepseek transport with sensitive egress class should be blocked
  const blockers = result.blockers as string[];
  assert.ok(
    blockers.includes(
      "external_deepseek_requires_non_sensitive_bulk_egress"
    )
  );
});

// ==========================================================================
// runner.ts — modelComparisonPlan blocks deepseek
// ==========================================================================

test("modelComparisonPlan: respects custom transport option", () => {
  // modelComparisonPlan accepts local transports only; tests that candidates
  // use the transport specified in options.
  const result = modelComparisonPlan(
    baseManifest({ transport: "dry-run" as const }),
    { transport: "dry-run" as const }
  ) as { report: { candidates: Array<{ manifest: { transport: string } }> } };
  for (const candidate of result.report.candidates) {
    assert.equal(candidate.manifest.transport, "dry-run");
  }
});

// ==========================================================================
// runner.ts — failing to process with max_tokens and deepseek without receipt
// ==========================================================================

test("buildExecutionPlan: deepseek with max_tokens but no receipt still blocked", () => {
  const manifest = parseManifest(
    baseManifest({
      transport: "deepseek" as const,
      max_tokens: 1000,
      concurrency: 5,
      cost_cap_usd: 3,
    })
  );
  const plan = buildExecutionPlan(manifest, {
    mode: "plan",
    allowLive: true,
    apiKeyPresent: true,
  });
  // Should still be blocked due to missing signed approval receipt
  assert.equal(plan.ok, false);
  assert.ok(
    plan.blockers.includes("signed_approval_receipt_required_for_live_deepseek")
  );
});
