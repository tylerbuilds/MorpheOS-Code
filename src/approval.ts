import { createHash, verify } from "node:crypto";
import { HarnessError } from "./errors.js";
import type { ApprovalReceipt, RunManifest } from "./schema.js";
import { buildDeepSeekRequest } from "./transport.js";

export interface ApprovalValidation {
  ok: boolean;
  blockers: string[];
  network_payload_sha256: string;
  receipt_sha256: string | null;
}

export function canonicalJson(value: unknown): string {
  return _canonicalJson(value, 0);
}

function _canonicalJson(value: unknown, depth: number): string {
  if (depth > 200) {
    throw new HarnessError(
      "circular_reference",
      "canonicalJson exceeded maximum nesting depth — probable circular reference"
    );
  }
  if (value === undefined) {
    // JSON.stringify(undefined) returns undefined (not a string).
    // We return "null" to keep the contract that canonicalJson always returns a string.
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => _canonicalJson(item, depth + 1)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${_canonicalJson(record[key], depth + 1)}`)
    .join(",")}}`;
}

export function networkPayloadDigest(manifest: RunManifest): string {
  const payloads = manifest.items.map((item) => buildDeepSeekRequest(manifest, item));
  return createHash("sha256").update(canonicalJson(payloads)).digest("hex");
}

export function receiptSigningPayload(receipt: ApprovalReceipt): string {
  const { signature_base64: _signature, ...unsigned } = receipt;
  return canonicalJson(unsigned);
}

export function receiptDigest(receipt: ApprovalReceipt): string {
  return createHash("sha256").update(canonicalJson(receipt)).digest("hex");
}

export function validateApprovalReceipt(
  manifest: RunManifest,
  publicKeyPem: string | undefined,
  now = new Date()
): ApprovalValidation {
  const blockers: string[] = [];
  const payloadDigest = networkPayloadDigest(manifest);
  const receipt = manifest.approval_receipt;
  if (!receipt) {
    return {
      ok: false,
      blockers: ["signed_approval_receipt_required_for_live_deepseek"],
      network_payload_sha256: payloadDigest,
      receipt_sha256: null
    };
  }

  if (!publicKeyPem?.trim()) {
    blockers.push("approval_receipt_public_key_not_configured");
  }
  if (receipt.status !== "approved" || receipt.issuer !== "owner") {
    blockers.push("approval_receipt_not_owner_approved");
  }
  const issuedAt = Date.parse(receipt.issued_at);
  const expiresAt = Date.parse(receipt.expires_at);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    blockers.push("approval_receipt_time_window_invalid");
  } else {
    if (issuedAt > now.getTime() + 5 * 60_000) {
      blockers.push("approval_receipt_not_yet_valid");
    }
    if (expiresAt <= now.getTime()) {
      blockers.push("approval_receipt_expired");
    }
  }
  if (receipt.provider !== "deepseek") {
    blockers.push("approval_receipt_provider_mismatch");
  }
  if (receipt.model !== manifest.model) {
    blockers.push("approval_receipt_model_mismatch");
  }
  if (receipt.egress_class !== manifest.egress_class || receipt.egress_class !== "non_sensitive_bulk") {
    blockers.push("approval_receipt_egress_mismatch");
  }
  if (receipt.network_payload_sha256 !== payloadDigest) {
    blockers.push("approval_receipt_payload_digest_mismatch");
  }
  if (manifest.items.length > receipt.max_items) {
    blockers.push("approval_receipt_item_cap_exceeded");
  }
  if (manifest.concurrency > receipt.max_concurrency) {
    blockers.push("approval_receipt_concurrency_cap_exceeded");
  }
  if (manifest.cost_cap_usd > receipt.max_cost_usd) {
    blockers.push("approval_receipt_run_cost_cap_exceeded");
  }
  if (receipt.max_cost_usd > receipt.daily_cost_cap_usd) {
    blockers.push("approval_receipt_daily_cost_cap_invalid");
  }

  if (publicKeyPem?.trim()) {
    try {
      const signature = Buffer.from(receipt.signature_base64, "base64");
      const valid = signature.length > 0 && verify(
        null,
        Buffer.from(receiptSigningPayload(receipt), "utf8"),
        publicKeyPem,
        signature
      );
      if (!valid) {
        blockers.push("approval_receipt_signature_invalid");
      }
    } catch {
      blockers.push("approval_receipt_signature_invalid");
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    network_payload_sha256: payloadDigest,
    receipt_sha256: receiptDigest(receipt)
  };
}
