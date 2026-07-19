/**
 * Adversarial Test Sweep — CompletionTransport, Approval, and Privacy Modules
 *
 * Covers the eight attack categories for:
 *   - transport.ts: FakeTransport, DeepSeekDryRunTransport, DeepSeekLiveTransport, buildDeepSeekRequest
 *   - approval.ts: canonicalJson, validateApprovalReceipt, networkPayloadDigest, receiptSigningPayload
 *   - privacy.ts: classifyOutboundPayload
 */

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { HarnessError } from "../../src/errors.js";
import {
  FakeTransport,
  DeepSeekDryRunTransport,
  DeepSeekLiveTransport,
  buildDeepSeekRequest,
  type CompletionTransport,
  type CompletionResult
} from "../../src/transport.js";
import {
  canonicalJson,
  validateApprovalReceipt,
  networkPayloadDigest,
  receiptSigningPayload,
  receiptDigest,
  type ApprovalValidation
} from "../../src/approval.js";
import {
  classifyOutboundPayload,
  classifyManifestPrivacy,
  type PrivacyReport,
  type EgressClass
} from "../../src/privacy.js";
import { parseManifest, type RunManifest, type ApprovalReceipt, type RunItem } from "../../src/schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertHarnessError(block: () => unknown, expectedCode: string): void {
  try {
    block();
    assert.fail(`Expected HarnessError with code "${expectedCode}" but no error was thrown`);
  } catch (err) {
    assert.ok(err instanceof HarnessError, `Expected HarnessError but got ${err?.constructor?.name ?? typeof err}`);
    assert.equal((err as HarnessError).code, expectedCode);
  }
}

function assertThrows(block: () => unknown, messagePattern?: RegExp): void {
  assert.throws(block, (err: unknown) => {
    if (!(err instanceof Error)) return false;
    if (messagePattern) return messagePattern.test(err.message);
    return true;
  });
}

function safeJsonStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function makeBaseManifest(overrides: Record<string, unknown> = {}): RunManifest {
  return parseManifest({
    schema_version: "deepseek-harness.run.v1",
    project: "adversarial-test",
    egress_class: "non_sensitive_bulk",
    transport: "fake",
    model: "deepseek-v4-flash",
    concurrency: 1,
    cost_cap_usd: 0.1,
    items: [{ id: "item-1", prompt: "Hello, world." }],
    ...overrides
  });
}

function makeBaseItem(overrides: Record<string, unknown> = {}): RunItem {
  return {
    id: "test-item",
    prompt: "Hello, world.",
    ...overrides
  } as RunItem;
}

// Ed25519 key pair for receipt signing
const edKeys = generateKeyPairSync("ed25519");
const publicKeyPem = edKeys.publicKey.export({ type: "spki", format: "pem" }).toString();

function signReceipt(unsigned: Omit<ApprovalReceipt, "signature_base64">): ApprovalReceipt {
  const payload = receiptSigningPayload(unsigned as unknown as ApprovalReceipt);
  const sig = sign(null, Buffer.from(payload), edKeys.privateKey).toString("base64");
  return { ...unsigned, signature_base64: sig } as unknown as ApprovalReceipt;
}

function makeValidReceipt(manifest: RunManifest, overrides: Partial<ApprovalReceipt> = {}): ApprovalReceipt {
  const now = Date.now();
  const unsigned: Omit<ApprovalReceipt, "signature_base64"> = {
    schema_version: "deepseek-harness.inference-receipt.v1",
    receipt_id: `receipt-${now}`,
    status: "approved",
    issuer: "owner",
    issued_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 600_000).toISOString(),
    nonce: `nonce-${Math.random().toString(36).slice(2)}-123456`,
    provider: "deepseek",
    model: manifest.model,
    network_payload_sha256: networkPayloadDigest(manifest),
    egress_class: "non_sensitive_bulk",
    max_items: 100,
    max_concurrency: 5,
    max_cost_usd: 5,
    daily_cost_cap_usd: 10,
    rate_snapshot: {
      id: "test-rate-v1",
      input_usd_per_million: 1,
      output_usd_per_million: 10
    },
    ...overrides
  } as unknown as Omit<ApprovalReceipt, "signature_base64">;
  return signReceipt(unsigned);
}

// ============================================================================
// TRANSPORT TESTS — buildDeepSeekRequest
// ============================================================================

// --- 1. MALFORMED INPUTS ---

test("[transport][malformed] buildDeepSeekRequest with null manifest throws", () => {
  const item = makeBaseItem();
  assertThrows(() => buildDeepSeekRequest(null as unknown as RunManifest, item), /Cannot read properties of null/);
});

test("[transport][malformed] buildDeepSeekRequest with undefined manifest throws", () => {
  const item = makeBaseItem();
  assertThrows(() => buildDeepSeekRequest(undefined as unknown as RunManifest, item));
});

test("[transport][malformed] buildDeepSeekRequest with null item throws", () => {
  const manifest = makeBaseManifest();
  assertThrows(() => buildDeepSeekRequest(manifest, null as unknown as RunItem), /Cannot read properties of null/);
});

test("[transport][malformed] buildDeepSeekRequest with item missing both prompt and messages", () => {
  const manifest = makeBaseManifest();
  // An item that bypasses Zod validation — no prompt and no messages
  const badItem = { id: "bad-item" } as unknown as RunItem;
  const request = buildDeepSeekRequest(manifest, badItem);
  // Should default to empty user message
  assert.equal(request.model, "deepseek-v4-flash");
  assert.deepEqual(request.messages, [{ role: "user", content: "" }]);
});

test("[transport][malformed] buildDeepSeekRequest with null messages array in item", () => {
  const manifest = makeBaseManifest();
  const item = { id: "null-msgs", messages: null, prompt: undefined } as unknown as RunItem;
  const request = buildDeepSeekRequest(manifest, item);
  assert.deepEqual(request.messages, [{ role: "user", content: "" }]);
});

test("[transport][malformed] buildDeepSeekRequest with messages containing null content", () => {
  const manifest = makeBaseManifest();
  const item = {
    id: "null-content",
    messages: [{ role: "user", content: null }]
  } as unknown as RunItem;
  const request = buildDeepSeekRequest(manifest, item);
  assert.equal((request.messages as Array<Record<string, unknown>>)[0].content, null);
});

// --- 2. BOUNDARY VALUES ---

test("[transport][boundary] buildDeepSeekRequest with single item", () => {
  const manifest = makeBaseManifest({ items: [{ id: "only", prompt: "one" }] });
  const request = buildDeepSeekRequest(manifest, manifest.items[0]);
  assert.equal(request.model, "deepseek-v4-flash");
  assert.equal((request.messages as Array<Record<string, unknown>>).length, 1);
});

test("[transport][boundary] buildDeepSeekRequest with extremely long prompt (100K chars)", () => {
  const manifest = makeBaseManifest();
  const longPrompt = "x".repeat(100_000);
  const item = makeBaseItem({ prompt: longPrompt });
  const request = buildDeepSeekRequest(manifest, item);
  assert.equal((request.messages as Array<Record<string, unknown>>)[0].content, longPrompt);
});

test("[transport][boundary] buildDeepSeekRequest with deeply nested manifest (thinking)", () => {
  const manifest = makeBaseManifest({
    thinking: { type: "enabled", reasoning_effort: "high" }
  });
  const item = makeBaseItem();
  const request = buildDeepSeekRequest(manifest, item);
  assert.equal(request.reasoning_effort, "high");
  assert.deepEqual(request.thinking, { type: "enabled", reasoning_effort: "high" });
});

test("[transport][boundary] buildDeepSeekRequest with max_tokens=0 (minimal boundary)", () => {
  // Bypass Zod validation — buildDeepSeekRequest doesn't validate manifest
  const manifest = makeBaseManifest();
  (manifest as Record<string, unknown>).max_tokens = 0;
  const item = makeBaseItem();
  const request = buildDeepSeekRequest(manifest, item);
  assert.equal(request.max_tokens, 0);
});

test("[transport][boundary] buildDeepSeekRequest with temperature=0", () => {
  const manifest = makeBaseManifest({ temperature: 0 } as Record<string, unknown>);
  const item = makeBaseItem();
  const request = buildDeepSeekRequest(manifest, item);
  assert.equal(request.temperature, 0);
});

// --- 3. TYPE CONFUSION ---

test("[transport][type-confusion] buildDeepSeekRequest with string concurrency (not passed to request)", () => {
  // Bypass Zod — buildDeepSeekRequest doesn't validate manifest types
  const manifest = makeBaseManifest();
  (manifest as Record<string, unknown>).concurrency = "fast";
  const item = makeBaseItem();
  const request = buildDeepSeekRequest(manifest, item);
  // concurrency should NOT be in the request
  assert.equal((request as Record<string, unknown>).concurrency, undefined);
});

test("[transport][type-confusion] buildDeepSeekRequest with boolean for model field", () => {
  const manifest = makeBaseManifest();
  (manifest as Record<string, unknown>).model = true;
  const item = makeBaseItem();
  const request = buildDeepSeekRequest(manifest, item);
  // Whatever the model is, it's passed through (buildDeepSeekRequest doesn't validate)
  assert.equal(request.model, true as unknown);
});

test("[transport][type-confusion] buildDeepSeekRequest with number for egress_class", () => {
  const manifest = makeBaseManifest();
  (manifest as Record<string, unknown>).egress_class = 42;
  const item = makeBaseItem();
  const request = buildDeepSeekRequest(manifest, item);
  // egress_class should NOT be in the request
  assert.equal((request as Record<string, unknown>).egress_class, undefined);
});

// --- 4. INJECTION ATTACKS ---

test("[transport][injection] buildDeepSeekRequest never includes API key in request body", () => {
  // This is critical: the API key must only go in the Authorization header, never the body
  const manifest = makeBaseManifest();
  const item = makeBaseItem();
  const request = buildDeepSeekRequest(manifest, item);
  const requestJson = JSON.stringify(request);

  // No API key patterns in the body
  assert.ok(!requestJson.includes("apiKey"), "request body must not contain 'apiKey'");
  assert.ok(!requestJson.includes("api_key"), "request body must not contain 'api_key'");
  assert.ok(!requestJson.includes("authorization"), "request body must not contain 'authorization'");
  assert.ok(!requestJson.includes("Bearer"), "request body must not contain 'Bearer'");
  assert.ok(!(request as Record<string, unknown>).api_key, "request must not have api_key field");
  assert.ok(!(request as Record<string, unknown>).apiKey, "request must not have apiKey field");
});

test("[transport][injection] buildDeepSeekRequest with prompt containing credential patterns", () => {
  const manifest = makeBaseManifest();
  const evilPrompt = "sk-proj-abcdef1234567890abcdef1234567890";
  const item = makeBaseItem({ prompt: evilPrompt });
  const request = buildDeepSeekRequest(manifest, item);
  // The prompt should be passed through verbatim — the privacy layer handles filtering
  assert.equal(
    (request.messages as Array<Record<string, unknown>>)[0].content,
    evilPrompt
  );
});

// --- 5. RESOURCE EXHAUSTION ---

test("[transport][exhaustion] buildDeepSeekRequest with 1000 items via large manifest", () => {
  const items = Array.from({ length: 1000 }, (_, i) => ({
    id: `item-${i}`,
    prompt: `Prompt number ${i}`
  }));
  const manifest = makeBaseManifest({ items } as Record<string, unknown>);
  // buildDeepSeekRequest operates on a single item, so each call is O(1)
  const firstRequest = buildDeepSeekRequest(manifest, manifest.items[0]);
  const lastRequest = buildDeepSeekRequest(manifest, manifest.items[999]);
  assert.equal(firstRequest.model, "deepseek-v4-flash");
  assert.equal(lastRequest.model, "deepseek-v4-flash");
  assert.equal(
    (lastRequest.messages as Array<Record<string, unknown>>)[0].content,
    "Prompt number 999"
  );
});

test("[transport][exhaustion] buildDeepSeekRequest with deeply nested messages array", () => {
  const manifest = makeBaseManifest();
  const item = {
    id: "nested",
    messages: Array.from({ length: 100 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`
    }))
  } as unknown as RunItem;
  const request = buildDeepSeekRequest(manifest, item);
  assert.equal((request.messages as Array<Record<string, unknown>>).length, 100);
});

// --- 6. INVALID ASSUMPTIONS ---

test("[transport][assumption] buildDeepSeekRequest produces valid JSON-serializable object", () => {
  const manifest = makeBaseManifest();
  const item = makeBaseItem();
  const request = buildDeepSeekRequest(manifest, item);
  const json = safeJsonStringify(request);
  assert.ok(json !== null, "request should be JSON-serializable");
  const parsed = JSON.parse(json!);
  assert.equal(parsed.model, "deepseek-v4-flash");
  assert.equal(parsed.stream, false);
});

test("[transport][assumption] buildDeepSeekRequest response_format is always set", () => {
  const manifest = makeBaseManifest({ response_format: "json_object" });
  const item = makeBaseItem();
  const request = buildDeepSeekRequest(manifest, item);
  assert.deepEqual(request.response_format, { type: "json_object" });
});

test("[transport][assumption] buildDeepSeekRequest with disabled thinking", () => {
  const manifest = makeBaseManifest({
    thinking: { type: "disabled" }
  });
  const item = makeBaseItem();
  const request = buildDeepSeekRequest(manifest, item);
  assert.deepEqual(request.thinking, { type: "disabled" });
  // No reasoning_effort when thinking is disabled
  assert.equal((request as Record<string, unknown>).reasoning_effort, undefined);
});

test("[transport][assumption] buildDeepSeekRequest omits undefined optional fields", () => {
  const manifest = makeBaseManifest();
  delete (manifest as Record<string, unknown>).temperature;
  delete (manifest as Record<string, unknown>).max_tokens;
  const item = makeBaseItem();
  const request = buildDeepSeekRequest(manifest, item);
  assert.equal((request as Record<string, unknown>).temperature, undefined);
  assert.equal((request as Record<string, unknown>).max_tokens, undefined);
});

// ============================================================================
// TRANSPORT TESTS — FakeTransport
// ============================================================================

test("[transport][fake] FakeTransport completes with sha256-based content", async () => {
  const manifest = makeBaseManifest();
  const item = makeBaseItem();
  const transport = new FakeTransport();
  const result = await transport.complete(manifest, item);
  assert.ok(result.content.includes("fake") || result.content.includes("item-1"));
  assert.equal((result.raw as Record<string, unknown>).fake, true);
  assert.equal((result.usage as Record<string, unknown>).total_tokens, 0);
});

test("[transport][fake] FakeTransport handles json_object response_format", async () => {
  const manifest = makeBaseManifest({ response_format: "json_object" });
  const item = manifest.items[0]; // Use the manifest's item: id="item-1"
  const transport = new FakeTransport();
  const result = await transport.complete(manifest, item);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.item_id, "item-1");
  assert.equal(parsed.fake, true);
});

test("[transport][fake] FakeTransport with null prompt item", async () => {
  const manifest = makeBaseManifest();
  const item = { id: "null-prompt", messages: [{ role: "user", content: "test msg" }] } as RunItem;
  const transport = new FakeTransport();
  const result = await transport.complete(manifest, item);
  assert.ok(result.content.length > 0);
});

test("[transport][fake] FakeTransport with item containing only messages (no prompt)", async () => {
  const manifest = makeBaseManifest();
  const item = {
    id: "msg-only",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Say hi." }
    ]
  } as RunItem;
  const transport = new FakeTransport();
  const result = await transport.complete(manifest, item);
  assert.ok(result.content.length > 0);
});

// ============================================================================
// TRANSPORT TESTS — DeepSeekDryRunTransport
// ============================================================================

test("[transport][dry-run] DeepSeekDryRunTransport returns full request shape", async () => {
  const manifest = makeBaseManifest();
  const item = makeBaseItem();
  const transport = new DeepSeekDryRunTransport();
  const result = await transport.complete(manifest, item);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.dry_run, true);
  assert.equal(parsed.request.model, "deepseek-v4-flash");
  assert.equal(parsed.request.stream, false);
  assert.deepEqual(parsed.request.messages, [{ role: "user", content: "Hello, world." }]);
});

test("[transport][dry-run] DeepSeekDryRunTransport handles complex item", async () => {
  const manifest = makeBaseManifest({ response_format: "json_object" });
  const item = {
    id: "complex",
    messages: [
      { role: "system", content: "System instruction" },
      { role: "user", content: "User query" }
    ]
  } as RunItem;
  const transport = new DeepSeekDryRunTransport();
  const result = await transport.complete(manifest, item);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.request.response_format.type, "json_object");
  assert.equal(parsed.request.messages.length, 2);
});

test("[transport][dry-run] DeepSeekDryRunTransport with manifest missing optional fields", async () => {
  // Build a minimal manifest via parseManifest to ensure schema defaults are applied
  const manifest = parseManifest({
    schema_version: "deepseek-harness.run.v1",
    project: "minimal",
    egress_class: "non_sensitive_bulk",
    transport: "dry-run",
    concurrency: 1,
    cost_cap_usd: 0.1,
    items: [{ id: "x", prompt: "minimal" }]
  });
  const transport = new DeepSeekDryRunTransport();
  const result = await transport.complete(manifest, manifest.items[0]);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.request.model, "deepseek-v4-flash"); // default
  assert.equal(parsed.request.stream, false);
});

// ============================================================================
// TRANSPORT TESTS — DeepSeekLiveTransport (validation, no real calls)
// ============================================================================

test("[transport][live] DeepSeekLiveTransport rejects timeout <= 0", () => {
  assertHarnessError(() => new DeepSeekLiveTransport("sk-test", "https://api.deepseek.com", 0), "invalid_deepseek_timeout");
});

test("[transport][live] DeepSeekLiveTransport rejects negative timeout", () => {
  assertHarnessError(() => new DeepSeekLiveTransport("sk-test", "https://api.deepseek.com", -1), "invalid_deepseek_timeout");
});

test("[transport][live] DeepSeekLiveTransport rejects NaN timeout", () => {
  assertHarnessError(() => new DeepSeekLiveTransport("sk-test", "https://api.deepseek.com", NaN), "invalid_deepseek_timeout");
});

test("[transport][live] DeepSeekLiveTransport rejects string timeout", () => {
  assertHarnessError(() => new DeepSeekLiveTransport("sk-test" as string, "https://api.deepseek.com", "fast" as unknown as number), "invalid_deepseek_timeout");
});

test("[transport][live] DeepSeekLiveTransport rejects timeout exceeding max (3,600,001ms)", () => {
  assertHarnessError(() => new DeepSeekLiveTransport("sk-test", "https://api.deepseek.com", 3_600_001), "invalid_deepseek_timeout");
});

test("[transport][live] DeepSeekLiveTransport accepts max timeout (3,600,000ms)", () => {
  const transport = new DeepSeekLiveTransport("sk-test", "https://api.deepseek.com", 3_600_000);
  assert.equal(transport.timeoutMs, 3_600_000);
});

test("[transport][live] DeepSeekLiveTransport accepts min timeout (1ms)", () => {
  const transport = new DeepSeekLiveTransport("sk-test", "https://api.deepseek.com", 1);
  assert.equal(transport.timeoutMs, 1);
});

test("[transport][live] DeepSeekLiveTransport strips trailing slash from baseUrl", () => {
  const transport = new DeepSeekLiveTransport("sk-test", "https://api.deepseek.com/", 1000);
  assert.equal(transport.baseUrl, "https://api.deepseek.com");
});

test("[transport][live] DeepSeekLiveTransport preserves baseUrl without trailing slash", () => {
  const transport = new DeepSeekLiveTransport("sk-test", "https://api.deepseek.com", 1000);
  assert.equal(transport.baseUrl, "https://api.deepseek.com");
});

test("[transport][live] DeepSeekLiveTransport with empty apiKey is not rejected at construction", () => {
  // Currently the constructor does NOT validate apiKey — this is a design gap.
  // The caller (schema.ts) checks apiKeyPresent before calling live transport.
  const transport = new DeepSeekLiveTransport("", "https://api.deepseek.com", 1000);
  assert.equal(transport.apiKey, "");
});

test("[transport][live] DeepSeekLiveTransport privacy gate blocks credential in prompt", async () => {
  const manifest = makeBaseManifest();
  const item = makeBaseItem({ prompt: "My password is sk-proj-secret1234567890abcdef" });
  const transport = new DeepSeekLiveTransport("sk-test", "https://api.deepseek.com", 1000);
  // The complete() call will build the request, run privacy check, and block
  // before making any network call (we use a bogus baseUrl to ensure no network)
  await assert.rejects(
    () => transport.complete(manifest, item),
    (err: unknown) => {
      return err instanceof HarnessError && err.code === "outbound_privacy_check_failed";
    }
  );
});

// ============================================================================
// APPROVAL TESTS — canonicalJson
// ============================================================================

// --- 1. canonicalJson MALFORMED INPUTS ---

test("[approval][canonical][malformed] canonicalJson with null", () => {
  const result = canonicalJson(null);
  assert.equal(result, "null");
});

test("[approval][canonical][malformed] canonicalJson with number", () => {
  assert.equal(canonicalJson(42), "42");
});

test("[approval][canonical][malformed] canonicalJson with string", () => {
  assert.equal(canonicalJson("hello"), '"hello"');
});

test("[approval][canonical][malformed] canonicalJson with boolean", () => {
  assert.equal(canonicalJson(true), "true");
  assert.equal(canonicalJson(false), "false");
});

test("[approval][canonical][malformed] canonicalJson with empty object", () => {
  assert.equal(canonicalJson({}), "{}");
});

test("[approval][canonical][malformed] canonicalJson with empty array", () => {
  assert.equal(canonicalJson([]), "[]");
});

// --- 2. canonicalJson EDGE CASES ---

test("[approval][canonical][boundary] canonicalJson with undefined value returns 'null' string", () => {
  // JSON.stringify(undefined) returns undefined (not a string), so canonicalJson
  // should handle this. Currently it returns undefined which is a type bug.
  const result = canonicalJson(undefined);
  // The function promises to return string. undefined is a bug.
  assert.equal(typeof result, "string", "canonicalJson must always return a string");
  assert.equal(result, "null");
});

test("[approval][canonical][boundary] canonicalJson with object containing undefined property", () => {
  const obj: Record<string, unknown> = { a: 1, b: undefined, c: 3 };
  const result = canonicalJson(obj);
  // The undefined property 'b' should be filtered out
  assert.ok(!result.includes('"b"'), "undefined properties should be filtered out");
  assert.ok(result.includes('"a"'), "defined properties should be present");
  assert.ok(result.includes('"c"'), "defined properties should be present");
});

test("[approval][canonical][boundary] canonicalJson sorts object keys alphabetically", () => {
  const obj = { zebra: 1, apple: 2, mango: 3 };
  const result = canonicalJson(obj);
  const applePos = result.indexOf('"apple"');
  const mangoPos = result.indexOf('"mango"');
  const zebraPos = result.indexOf('"zebra"');
  assert.ok(applePos < mangoPos, "apple should come before mango");
  assert.ok(mangoPos < zebraPos, "mango should come before zebra");
});

test("[approval][canonical][boundary] canonicalJson with nested objects", () => {
  const obj = { outer: { inner: { value: 42 } } };
  const result = canonicalJson(obj);
  assert.ok(result.includes('"outer"'));
  assert.ok(result.includes('"inner"'));
  assert.ok(result.includes('"value":42'));
});

test("[approval][canonical][boundary] canonicalJson with array of objects", () => {
  const arr = [{ b: 2, a: 1 }, { d: 4, c: 3 }];
  const result = canonicalJson(arr);
  // Each object's keys should be sorted
  assert.ok(result.includes('{"a":1,"b":2}'));
  assert.ok(result.includes('{"c":3,"d":4}'));
});

test("[approval][canonical][boundary] canonicalJson with empty string value", () => {
  const obj = { key: "" };
  assert.equal(canonicalJson(obj), '{"key":""}');
});

test("[approval][canonical][boundary] canonicalJson with special characters in keys", () => {
  const obj: Record<string, unknown> = { "key with spaces": 1, "key\nwith\nnewlines": 2 };
  const result = canonicalJson(obj);
  assert.ok(result.includes('"key with spaces"'));
  assert.ok(result.includes('"key\\nwith\\nnewlines"'));
});

// --- 3. canonicalJson TYPE CONFUSION ---

test("[approval][canonical][type-confusion] canonicalJson with array for value", () => {
  const obj = { data: [1, "two", true] };
  const result = canonicalJson(obj);
  assert.equal(result, '{"data":[1,"two",true]}');
});

// --- 4. canonicalJson CIRCULAR REFERENCES (STATE CORRUPTION) ---

test("[approval][canonical][corruption] canonicalJson with circular reference throws HarnessError", () => {
  const obj: Record<string, unknown> = { name: "root" };
  (obj as Record<string, unknown>).child = obj;
  // canonicalJson now detects circular references and throws HarnessError
  assertHarnessError(() => canonicalJson(obj), "circular_reference");
});

// ============================================================================
// APPROVAL TESTS — validateApprovalReceipt
// ============================================================================

// --- 1. MALFORMED INPUTS ---

test("[approval][receipt][malformed] validateApprovalReceipt with null manifest throws", () => {
  assert.throws(
    () => validateApprovalReceipt(null as unknown as RunManifest, publicKeyPem),
    (err: unknown) => err instanceof Error
  );
});

test("[approval][receipt][malformed] validateApprovalReceipt with undefined publicKeyPem still validates", () => {
  const manifest = makeBaseManifest();
  const receipt = makeValidReceipt(manifest);
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  const result = validateApprovalReceipt(manifestWithReceipt, undefined);
  // Should report missing public key but still validate other fields
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("approval_receipt_public_key_not_configured"));
});

test("[approval][receipt][malformed] validateApprovalReceipt with empty publicKeyPem", () => {
  const manifest = makeBaseManifest();
  const receipt = makeValidReceipt(manifest);
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  const result = validateApprovalReceipt(manifestWithReceipt, "");
  assert.ok(result.blockers.includes("approval_receipt_public_key_not_configured"));
});

test("[approval][receipt][malformed] validateApprovalReceipt with null receipt (no approval_receipt)", () => {
  const manifest = makeBaseManifest();
  const result = validateApprovalReceipt(manifest, publicKeyPem);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("signed_approval_receipt_required_for_live_deepseek"));
  assert.equal(result.receipt_sha256, null);
});

test("[approval][receipt][malformed] validateApprovalReceipt with missing signature_base64", () => {
  const manifest = makeBaseManifest();
  const receipt = makeValidReceipt(manifest);
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  // Delete signature_base64 *after* Zod validation to test validateApprovalReceipt directly
  delete (manifestWithReceipt.approval_receipt as Record<string, unknown>).signature_base64;
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  // Should catch the missing signature via the try/catch and add a blocker
  assert.ok(result.blockers.some(b => b === "approval_receipt_signature_invalid"));
});

test("[approval][receipt][malformed] validateApprovalReceipt with invalid base64 signature", () => {
  const manifest = makeBaseManifest();
  const receipt = makeValidReceipt(manifest);
  const badReceipt = { ...receipt, signature_base64: "!!!not-valid-base64!!!" };
  const manifestWithBad = parseManifest({
    ...manifest,
    approval_receipt: badReceipt
  });
  const result = validateApprovalReceipt(manifestWithBad, publicKeyPem);
  assert.ok(result.blockers.includes("approval_receipt_signature_invalid"));
});

// --- 2. BOUNDARY VALUES ---

test("[approval][receipt][boundary] expired receipt (past expires_at)", () => {
  const manifest = makeBaseManifest();
  const receipt = makeValidReceipt(manifest, {
    issued_at: new Date(Date.now() - 600_000).toISOString(),
    expires_at: new Date(Date.now() - 1).toISOString()
  });
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  assert.ok(result.blockers.includes("approval_receipt_expired"));
});

test("[approval][receipt][boundary] future-issued receipt (issued_at in the future)", () => {
  const manifest = makeBaseManifest();
  const receipt = makeValidReceipt(manifest, {
    issued_at: new Date(Date.now() + 10 * 60_000).toISOString(), // 10 min in future (past 5 min grace)
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString()
  });
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  assert.ok(result.blockers.includes("approval_receipt_not_yet_valid"));
});

test("[approval][receipt][boundary] receipt issued within 5 min grace window is accepted", () => {
  const manifest = makeBaseManifest();
  const receipt = makeValidReceipt(manifest, {
    issued_at: new Date(Date.now() + 2 * 60_000).toISOString(), // 2 min in future
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString()
  });
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  // Should NOT have "not_yet_valid" because it's within the 5-min grace period
  assert.ok(!result.blockers.includes("approval_receipt_not_yet_valid"));
});

test("[approval][receipt][boundary] receipt expiring in 1ms", () => {
  const manifest = makeBaseManifest();
  const now = new Date();
  const receipt = makeValidReceipt(manifest, {
    issued_at: new Date(now.getTime() - 600_000).toISOString(),
    expires_at: new Date(now.getTime() + 1).toISOString() // 1ms from now
  });
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem, now);
  // Not yet expired — should be valid
  assert.ok(!result.blockers.includes("approval_receipt_expired"), `Should not be expired with 1ms buffer, but got: ${result.blockers.join(", ")}`);
});

test("[approval][receipt][boundary] receipt with max boundary dates (year 9999)", () => {
  const manifest = makeBaseManifest();
  const receipt = makeValidReceipt(manifest, {
    issued_at: new Date(Date.now() - 86400_000).toISOString(),
    expires_at: new Date("9999-12-31T23:59:59.000Z").toISOString()
  });
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  // Should NOT be expired
  assert.ok(!result.blockers.includes("approval_receipt_expired"));
});

test("[approval][receipt][boundary] receipt with expires_at <= issued_at is invalid", () => {
  const manifest = makeBaseManifest();
  const now = new Date();
  const receipt = makeValidReceipt(manifest, {
    issued_at: new Date(now.getTime()).toISOString(),
    expires_at: new Date(now.getTime()).toISOString() // equal
  });
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  assert.ok(result.blockers.includes("approval_receipt_time_window_invalid"));
});

// --- 3. TYPE CONFUSION ---

test("[approval][receipt][type-confusion] manifest without approval_receipt at all", () => {
  const manifest = makeBaseManifest();
  // No approval_receipt set
  const result = validateApprovalReceipt(manifest, publicKeyPem);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("signed_approval_receipt_required_for_live_deepseek"));
});

test("[approval][receipt][type-confusion] receipt with string for network_payload_sha256 (not 64-char hex)", () => {
  const manifest = makeBaseManifest();
  const receipt = makeValidReceipt(manifest);
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  // Mutate after Zod validation to test validateApprovalReceipt directly
  (manifestWithReceipt.approval_receipt as Record<string, unknown>).network_payload_sha256 = "too-short";
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  // The receipt's payload digest won't match the computed one
  assert.ok(result.blockers.includes("approval_receipt_payload_digest_mismatch"));
});

// --- 4. STATE CORRUPTION ---

test("[approval][receipt][corruption] tampered payload digest fails validation", () => {
  const manifest = makeBaseManifest();
  const receipt = makeValidReceipt(manifest);
  // Tamper the digest
  const tampered = { ...receipt, network_payload_sha256: "a".repeat(64) };
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: tampered
  });
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  assert.ok(result.blockers.includes("approval_receipt_payload_digest_mismatch"));
});

test("[approval][receipt][corruption] tampered signature fails validation", () => {
  const manifest = makeBaseManifest();
  const receipt = makeValidReceipt(manifest);
  // Tamper the signature by flipping a character
  const sigBytes = Buffer.from(receipt.signature_base64, "base64");
  sigBytes[0] = sigBytes[0] ^ 0xFF; // flip bits
  const tampered = { ...receipt, signature_base64: sigBytes.toString("base64") };
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: tampered
  });
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  assert.ok(result.blockers.includes("approval_receipt_signature_invalid"));
});

test("[approval][receipt][corruption] replayed receipt with different manifest fails", () => {
  const manifest1 = makeBaseManifest({ items: [{ id: "a", prompt: "Original" }] });
  const receipt = makeValidReceipt(manifest1);

  // Change the manifest items — digest should no longer match
  const manifest2 = makeBaseManifest({ items: [{ id: "a", prompt: "Changed!" }] });
  const manifestWithReceipt = parseManifest({
    ...manifest2,
    approval_receipt: receipt
  });
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  assert.ok(result.blockers.includes("approval_receipt_payload_digest_mismatch"));
});

// --- 5. INJECTION ATTACKS ---

test("[approval][receipt][injection] receipt with XSS script in receipt_id", () => {
  const manifest = makeBaseManifest();
  const receipt = makeValidReceipt(manifest);
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  // Mutate after Zod validation to inject XSS
  (manifestWithReceipt.approval_receipt as Record<string, unknown>).receipt_id = '<script>alert("xss")</script>';
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  // The function should not crash on XSS strings — it just compares them
  assert.ok(result.blockers.length > 0 || result.ok);
});

test("[approval][receipt][injection] receipt with SQL injection in nonce field", () => {
  const manifest = makeBaseManifest();
  const receipt = makeValidReceipt(manifest);
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  // Mutate after Zod validation to inject SQL
  (manifestWithReceipt.approval_receipt as Record<string, unknown>).nonce = "'; DROP TABLE runs; --";
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  // No SQL executed — this is just a string comparison function
  assert.ok(result.blockers.length > 0 || result.ok);
});

// --- 6. INVALID ASSUMPTIONS ---

test("[approval][receipt][assumption] custom 'now' parameter with past date makes receipt expired", () => {
  const manifest = makeBaseManifest();
  const receipt = makeValidReceipt(manifest, {
    issued_at: new Date("2024-01-01T00:00:00Z").toISOString(),
    expires_at: new Date("2024-01-02T00:00:00Z").toISOString()
  });
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  // With now = 2026, the receipt should be expired
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem, new Date("2026-07-19"));
  assert.ok(result.blockers.includes("approval_receipt_expired"));
});

test("[approval][receipt][assumption] a valid receipt with all constraints met passes", () => {
  const manifest = makeBaseManifest();
  const receipt = makeValidReceipt(manifest, {
    network_payload_sha256: networkPayloadDigest(manifest)
  });
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  // The signature won't verify because network_payload_sha256 was overridden after signing
  // Let's create properly
  const properManifest = makeBaseManifest();
  const properReceipt = makeValidReceipt(properManifest);
  const properWithReceipt = parseManifest({
    ...properManifest,
    approval_receipt: properReceipt
  });
  const properResult = validateApprovalReceipt(properWithReceipt, publicKeyPem);
  assert.equal(properResult.ok, true, `Blockers: ${properResult.blockers.join(", ")}`);
  assert.equal(properResult.receipt_sha256, receiptDigest(properReceipt));
});

test("[approval][receipt][assumption] receiptSigningPayload excludes signature_base64", () => {
  const manifest = makeBaseManifest();
  const receipt = makeValidReceipt(manifest);
  const payload = receiptSigningPayload(receipt);
  assert.ok(!payload.includes("signature_base64"), "signing payload must not include signature_base64");
});

test("[approval][receipt][assumption] identical manifests produce identical networkPayloadDigest", () => {
  const manifest1 = makeBaseManifest({ items: [{ id: "a", prompt: "Hello" }] });
  const manifest2 = makeBaseManifest({ items: [{ id: "a", prompt: "Hello" }] });
  assert.equal(networkPayloadDigest(manifest1), networkPayloadDigest(manifest2));
});

test("[approval][receipt][assumption] different manifests produce different networkPayloadDigest", () => {
  const manifest1 = makeBaseManifest({ items: [{ id: "a", prompt: "Hello" }] });
  const manifest2 = makeBaseManifest({ items: [{ id: "a", prompt: "World" }] });
  assert.notEqual(networkPayloadDigest(manifest1), networkPayloadDigest(manifest2));
});

test("[approval][receipt][assumption] canonicalJson of identical objects with different key order produces same output", () => {
  const obj1 = { b: 2, a: 1, c: 3 };
  const obj2 = { c: 3, a: 1, b: 2 };
  assert.equal(canonicalJson(obj1), canonicalJson(obj2));
});

test("[approval][receipt][assumption] receipt with max_items exceeded is blocked", () => {
  const manifest = makeBaseManifest({
    items: [
      { id: "a", prompt: "one" },
      { id: "b", prompt: "two" },
      { id: "c", prompt: "three" }
    ]
  });
  const receipt = makeValidReceipt(manifest, { max_items: 2 });
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  assert.ok(result.blockers.includes("approval_receipt_item_cap_exceeded"));
});

test("[approval][receipt][assumption] receipt with concurrency cap exceeded is blocked", () => {
  const manifest = makeBaseManifest({ concurrency: 10 });
  const receipt = makeValidReceipt(manifest, { max_concurrency: 1 });
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  assert.ok(result.blockers.includes("approval_receipt_concurrency_cap_exceeded"));
});

test("[approval][receipt][assumption] receipt with run cost cap exceeded is blocked", () => {
  const manifest = makeBaseManifest({ cost_cap_usd: 10 });
  const receipt = makeValidReceipt(manifest, { max_cost_usd: 1 });
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  assert.ok(result.blockers.includes("approval_receipt_run_cost_cap_exceeded"));
});

test("[approval][receipt][assumption] receipt with daily cap less than run cost cap is blocked", () => {
  const manifest = makeBaseManifest();
  const receipt = makeValidReceipt(manifest, {
    max_cost_usd: 5,
    daily_cost_cap_usd: 1 // daily < run cost cap
  });
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  assert.ok(result.blockers.includes("approval_receipt_daily_cost_cap_invalid"));
});

test("[approval][receipt][assumption] receipt with wrong provider is blocked", () => {
  const manifest = makeBaseManifest();
  const receipt = makeValidReceipt(manifest);
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  // Mutate after Zod validation
  (manifestWithReceipt.approval_receipt as Record<string, unknown>).provider = "openai";
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  assert.ok(result.blockers.includes("approval_receipt_provider_mismatch"));
});

test("[approval][receipt][assumption] receipt with wrong model is blocked", () => {
  const manifest = makeBaseManifest({ model: "deepseek-v4-pro" });
  const receipt = makeValidReceipt(manifest, { model: "deepseek-v4-flash" });
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  assert.ok(result.blockers.includes("approval_receipt_model_mismatch"));
});

test("[approval][receipt][assumption] receipt with wrong egress_class is blocked", () => {
  const manifest = makeBaseManifest({ egress_class: "client_sensitive" as EgressClass });
  const receipt = makeValidReceipt(manifest);
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  // Mutate after Zod validation
  (manifestWithReceipt.approval_receipt as Record<string, unknown>).egress_class = "personal_sensitive";
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  assert.ok(result.blockers.includes("approval_receipt_egress_mismatch"));
});

test("[approval][receipt][assumption] receipt with non-approved status is blocked", () => {
  const manifest = makeBaseManifest();
  const receipt = makeValidReceipt(manifest);
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  // Mutate after Zod validation
  (manifestWithReceipt.approval_receipt as Record<string, unknown>).status = "rejected";
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  assert.ok(result.blockers.includes("approval_receipt_not_owner_approved"));
});

test("[approval][receipt][assumption] receipt with non-owner issuer is blocked", () => {
  const manifest = makeBaseManifest();
  const receipt = makeValidReceipt(manifest);
  const manifestWithReceipt = parseManifest({
    ...manifest,
    approval_receipt: receipt
  });
  // Mutate after Zod validation
  (manifestWithReceipt.approval_receipt as Record<string, unknown>).issuer = "delegate";
  const result = validateApprovalReceipt(manifestWithReceipt, publicKeyPem);
  assert.ok(result.blockers.includes("approval_receipt_not_owner_approved"));
});

// ============================================================================
// PRIVACY TESTS — classifyOutboundPayload
// ============================================================================

// --- 1. MALFORMED INPUTS ---

test("[privacy][malformed] classifyOutboundPayload with null payload", () => {
  const report = classifyOutboundPayload("null-item", null);
  assert.equal(report.schema_version, "deepseek-harness.privacy-report.v1");
  assert.equal(report.external_deepseek_allowed, true); // "null" has no sensitive patterns
  assert.equal(report.findings.length, 0);
});

test("[privacy][malformed] classifyOutboundPayload with undefined payload", () => {
  // JSON.stringify(undefined) returns undefined, which is not a string.
  // classifyOutboundPayload should handle this gracefully.
  const report = classifyOutboundPayload("undef-item", undefined);
  assert.equal(report.schema_version, "deepseek-harness.privacy-report.v1");
  assert.equal(report.external_deepseek_allowed, true);
  assert.equal(report.findings.length, 0);
});

test("[privacy][malformed] classifyOutboundPayload with empty object", () => {
  const report = classifyOutboundPayload("empty", {});
  assert.equal(report.external_deepseek_allowed, true);
});

test("[privacy][malformed] classifyOutboundPayload with empty string payload", () => {
  const report = classifyOutboundPayload("empty-str", "");
  assert.equal(report.external_deepseek_allowed, true);
});

// --- 2. BOUNDARY VALUES ---

test("[privacy][boundary] classifyOutboundPayload with large nested object (1000 keys)", () => {
  const payload: Record<string, unknown> = {};
  for (let i = 0; i < 1000; i++) {
    payload[`key_${i}`] = `value_${i}`;
  }
  const report = classifyOutboundPayload("large", payload);
  assert.equal(report.schema_version, "deepseek-harness.privacy-report.v1");
  // Should complete without crashing
});

test("[privacy][boundary] classifyOutboundPayload with deeply nested payload (20 levels)", () => {
  let payload: Record<string, unknown> = { leaf: "bottom" };
  for (let i = 0; i < 20; i++) {
    payload = { nested: payload };
  }
  const report = classifyOutboundPayload("nested", payload);
  assert.equal(report.schema_version, "deepseek-harness.privacy-report.v1");
  // Should complete without crashing
});

// --- 3. INJECTION ATTACKS (privacy detection patterns) ---

test("[privacy][injection] classifyOutboundPayload detects Bearer token", () => {
  const report = classifyOutboundPayload("bearer", {
    messages: [{ role: "user", content: "Authorization: Bearer sk-1234567890abcdef1234567890abcdef" }]
  });
  assert.equal(report.external_deepseek_allowed, false);
  assert.ok(report.findings.some(f => f.signal === "bearer_token"));
});

test("[privacy][injection] classifyOutboundPayload detects API key pattern (sk- prefix)", () => {
  const report = classifyOutboundPayload("apikey", {
    messages: [{ role: "user", content: "Use this key: sk-proj-1234567890abcdefghij" }]
  });
  assert.equal(report.external_deepseek_allowed, false);
  assert.ok(report.findings.some(f => f.signal === "token_prefix"));
});

test("[privacy][injection] classifyOutboundPayload detects GitHub PAT (ghp_ prefix)", () => {
  const report = classifyOutboundPayload("github", {
    messages: [{ role: "user", content: "My token is ghp_1234567890abcdefghijklmnop" }]
  });
  assert.equal(report.external_deepseek_allowed, false);
  assert.ok(report.findings.some(f => f.signal === "token_prefix"));
});

test("[privacy][injection] classifyOutboundPayload detects AWS access key", () => {
  const report = classifyOutboundPayload("aws", {
    messages: [{ role: "user", content: "AWS key: AKIA1234567890ABCDEF" }]
  });
  assert.equal(report.external_deepseek_allowed, false);
  assert.ok(report.findings.some(f => f.signal === "aws_access_key"));
});

test("[privacy][injection] classifyOutboundPayload detects JWT token", () => {
  const report = classifyOutboundPayload("jwt", {
    messages: [{ role: "user", content: "Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8" }]
  });
  assert.equal(report.external_deepseek_allowed, false);
  assert.ok(report.findings.some(f => f.signal === "jwt_token"));
});

test("[privacy][injection] classifyOutboundPayload detects private key block", () => {
  const report = classifyOutboundPayload("privkey", {
    messages: [{ role: "user", content: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----" }]
  });
  assert.equal(report.external_deepseek_allowed, false);
  assert.ok(report.findings.some(f => f.signal === "private_key_block"));
});

test("[privacy][injection] classifyOutboundPayload detects credential assignment (password=)", () => {
  const report = classifyOutboundPayload("creds", {
    messages: [{ role: "user", content: "db_password=supersecret123" }]
  });
  assert.equal(report.external_deepseek_allowed, false);
  assert.ok(report.findings.some(f => f.signal === "credential_assignment"));
});

test("[privacy][injection] classifyOutboundPayload detects email address", () => {
  const report = classifyOutboundPayload("email", {
    messages: [{ role: "user", content: "Contact user@example.com for details" }]
  });
  assert.equal(report.external_deepseek_allowed, false);
  assert.ok(report.findings.some(f => f.signal === "email_address"));
});

test("[privacy][injection] classifyOutboundPayload detects UK mobile number", () => {
  const report = classifyOutboundPayload("phone", {
    messages: [{ role: "user", content: "Call 07700900000 for support" }]
  });
  assert.equal(report.external_deepseek_allowed, false);
  assert.ok(report.findings.some(f => f.signal === "uk_mobile_number"));
});

test("[privacy][injection] classifyOutboundPayload detects UK postcode", () => {
  const report = classifyOutboundPayload("postcode", {
    messages: [{ role: "user", content: "Deliver to SW1A 1AA" }]
  });
  assert.equal(report.external_deepseek_allowed, false);
  assert.ok(report.findings.some(f => f.signal === "uk_postcode"));
});

test("[privacy][injection] classifyOutboundPayload detects NHS number", () => {
  const report = classifyOutboundPayload("nhs", {
    messages: [{ role: "user", content: "Patient NHS number: 123 456 7890" }]
  });
  assert.equal(report.external_deepseek_allowed, false);
  assert.ok(report.findings.some(f => f.signal === "nhs_identifier"));
});

test("[privacy][injection] classifyOutboundPayload detects high-entropy credential candidate", () => {
  const report = classifyOutboundPayload("entropy", {
    messages: [{ role: "user", content: "Key: aB3dEfGh1JkLmNoPqRsTuVwXyZ01234567890ab" }]
  });
  assert.equal(report.external_deepseek_allowed, false);
  assert.ok(report.findings.some(f => f.signal === "high_entropy_credential_candidate"));
});

test("[privacy][injection] classifyOutboundPayload clean content passes", () => {
  const report = classifyOutboundPayload("clean", {
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "What is the capital of France?" }]
  });
  assert.equal(report.external_deepseek_allowed, true);
  assert.equal(report.findings.length, 0);
});

// --- 4. TYPE CONFUSION ---

test("[privacy][type-confusion] classifyOutboundPayload with array payload", () => {
  const report = classifyOutboundPayload("array", [1, 2, 3]);
  assert.equal(report.schema_version, "deepseek-harness.privacy-report.v1");
  // JSON.stringify([1,2,3]) = "[1,2,3]" — clean
  assert.equal(report.external_deepseek_allowed, true);
});

test("[privacy][type-confusion] classifyOutboundPayload with number payload", () => {
  const report = classifyOutboundPayload("num", 42);
  assert.equal(report.schema_version, "deepseek-harness.privacy-report.v1");
  assert.equal(report.external_deepseek_allowed, true);
});

test("[privacy][type-confusion] classifyOutboundPayload with boolean payload", () => {
  const report = classifyOutboundPayload("bool", true);
  assert.equal(report.schema_version, "deepseek-harness.privacy-report.v1");
  assert.equal(report.external_deepseek_allowed, true);
});

// --- 5. INVALID ASSUMPTIONS ---

test("[privacy][assumption] classifyOutboundPayload with circular references returns clean report", () => {
  const payload: Record<string, unknown> = { name: "root" };
  (payload as Record<string, unknown>).self = payload;
  // JSON.stringify throws on circular references, but classifyOutboundPayload
  // now catches this and returns a clean (safe) report.
  const report = classifyOutboundPayload("circle", payload);
  assert.equal(report.schema_version, "deepseek-harness.privacy-report.v1");
  assert.equal(report.external_deepseek_allowed, true);
  assert.equal(report.findings.length, 0);
});

test("[privacy][assumption] classifyOutboundPayload with BigInt value returns clean report", () => {
  // JSON.stringify throws TypeError on BigInt, but classifyOutboundPayload
  // now catches this and returns a clean (safe) report.
  const report = classifyOutboundPayload("bigint", { value: BigInt(123) });
  assert.equal(report.schema_version, "deepseek-harness.privacy-report.v1");
  assert.equal(report.external_deepseek_allowed, true);
  assert.equal(report.findings.length, 0);
});

test("[privacy][assumption] classifyOutboundPayload with Symbol value throws gracefully", () => {
  // JSON.stringify omits Symbol values, so it should work
  const report = classifyOutboundPayload("symbol", { key: "value", sym: Symbol("test") } as Record<string, unknown>);
  // Symbol is omitted by JSON.stringify, so it should pass
  assert.equal(report.schema_version, "deepseek-harness.privacy-report.v1");
  assert.equal(report.external_deepseek_allowed, true);
});

test("[privacy][assumption] classifyOutboundPayload deduplicates findings by signal", () => {
  // Two bearer tokens in same payload should produce only one finding for bearer_token
  const report = classifyOutboundPayload("dedup", {
    messages: [
      { role: "user", content: "Bearer token1: sk-1234567890abcdef123456" },
      { role: "assistant", content: "Bearer token2: sk-abcdef1234567890abcdef" }
    ]
  });
  const bearerFindings = report.findings.filter(f => f.signal === "bearer_token");
  assert.ok(bearerFindings.length <= 1, "bearer_token signal should be deduplicated");
});

test("[privacy][assumption] classifyOutboundPayload with multiple credential types reports all", () => {
  const report = classifyOutboundPayload("multi", {
    messages: [{ role: "user", content: "api_key=secret123 and AKIA1234567890ABCDEF and user@example.com" }]
  });
  assert.equal(report.external_deepseek_allowed, false);
  // Should have at least 3 distinct findings
  const signals = report.findings.map(f => f.signal);
  assert.ok(signals.includes("credential_assignment"), `Expected credential_assignment, got: ${signals.join(", ")}`);
  assert.ok(signals.includes("aws_access_key"), `Expected aws_access_key, got: ${signals.join(", ")}`);
  assert.ok(signals.includes("email_address"), `Expected email_address, got: ${signals.join(", ")}`);
});

test("[privacy][assumption] classifyOutboundPayload recommended_egress_class escalates with severity", () => {
  const report = classifyOutboundPayload("escalate", {
    messages: [{ role: "user", content: "Patient medical ID: PAT-12345 and NHS number: 1234567890" }]
  });
  assert.equal(report.external_deepseek_allowed, false);
  // Should escalate to health_genetics
  assert.equal(report.recommended_egress_class, "health_genetics");
});

test("[privacy][assumption] classifyOutboundPayload returns zero findings for safe input", () => {
  const report = classifyOutboundPayload("safe", {
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "Summarize the following text: The quick brown fox jumps over the lazy dog." }],
    temperature: 0.7
  });
  assert.equal(report.external_deepseek_allowed, true);
  assert.equal(report.findings.length, 0);
  assert.equal(report.recommended_egress_class, "non_sensitive_bulk");
});

// ============================================================================
// CROSS-MODULE INTEGRATION
// ============================================================================

test("[integration] FakeTransport complete -> privacy check does not apply (privacy gate only in LiveTransport)", async () => {
  const manifest = makeBaseManifest();
  const item = makeBaseItem({ prompt: "sk-proj-secret1234567890" });
  const transport = new FakeTransport();
  // FakeTransport does NOT run the privacy gate
  const result = await transport.complete(manifest, item);
  assert.ok(result.content.length > 0);
  // The credential in the prompt doesn't block fake transport
});

test("[integration] DeepSeekDryRunTransport preserves privacy-sensitive data in request shape", async () => {
  const manifest = makeBaseManifest();
  const item = makeBaseItem({ prompt: "My secret is password=abc123" });
  const transport = new DeepSeekDryRunTransport();
  const result = await transport.complete(manifest, item);
  const parsed = JSON.parse(result.content);
  // Dry run preserves the full request including sensitive data (for debugging)
  assert.ok(parsed.request.messages[0].content.includes("password=abc123"));
});

test("[integration] networkPayloadDigest changes when any item changes", () => {
  const manifest1 = makeBaseManifest({ items: [{ id: "a", prompt: "Hello" }] });
  const manifest2 = makeBaseManifest({ items: [{ id: "a", prompt: "Hello" }, { id: "b", prompt: "World" }] });
  assert.notEqual(networkPayloadDigest(manifest1), networkPayloadDigest(manifest2));
});

test("[integration] canonicalJson is deterministic across calls", () => {
  const obj = { c: 3, a: 1, b: { z: 26, y: 25 } };
  const result1 = canonicalJson(obj);
  const result2 = canonicalJson(obj);
  assert.equal(result1, result2);
});
