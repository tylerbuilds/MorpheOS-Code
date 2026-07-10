import type { ApprovalReceipt, RunItem, RunManifest } from "./schema.js";

export interface BudgetEstimate {
  input_tokens_reserved: number;
  output_tokens_reserved: number;
  reserved_usd: number;
  rate_snapshot_id: string;
}

function itemTextBytes(item: RunItem): number {
  const messages = item.messages ?? [{ role: "user", content: item.prompt ?? "" }];
  return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

export function estimateItemReservation(
  manifest: RunManifest,
  item: RunItem,
  receipt: ApprovalReceipt
): BudgetEstimate {
  if (!manifest.max_tokens) {
    throw new Error("max_tokens_required_for_live_budget_reservation");
  }
  // One token per UTF-8 byte plus per-message overhead is intentionally conservative.
  const inputTokens = itemTextBytes(item) + (item.messages?.length ?? 1) * 64;
  const outputTokens = manifest.max_tokens;
  const inputCost = (inputTokens / 1_000_000) * receipt.rate_snapshot.input_usd_per_million;
  const outputCost = (outputTokens / 1_000_000) * receipt.rate_snapshot.output_usd_per_million;
  return {
    input_tokens_reserved: inputTokens,
    output_tokens_reserved: outputTokens,
    reserved_usd: Number((inputCost + outputCost).toFixed(8)),
    rate_snapshot_id: receipt.rate_snapshot.id
  };
}

export function estimateManifestReservation(manifest: RunManifest, receipt: ApprovalReceipt): BudgetEstimate {
  const items = manifest.items.map((item) => estimateItemReservation(manifest, item, receipt));
  return {
    input_tokens_reserved: items.reduce((total, item) => total + item.input_tokens_reserved, 0),
    output_tokens_reserved: items.reduce((total, item) => total + item.output_tokens_reserved, 0),
    reserved_usd: Number(items.reduce((total, item) => total + item.reserved_usd, 0).toFixed(8)),
    rate_snapshot_id: receipt.rate_snapshot.id
  };
}

export function observedUsageCost(
  usage: unknown,
  receipt: ApprovalReceipt
): number | null {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const record = usage as Record<string, unknown>;
  const promptTokens = Number(record.prompt_tokens);
  const completionTokens = Number(record.completion_tokens);
  if (!Number.isFinite(promptTokens) || promptTokens < 0 || !Number.isFinite(completionTokens) || completionTokens < 0) {
    return null;
  }
  return Number((
    (promptTokens / 1_000_000) * receipt.rate_snapshot.input_usd_per_million
    + (completionTokens / 1_000_000) * receipt.rate_snapshot.output_usd_per_million
  ).toFixed(8));
}
