import { estimateManifestUsage } from "./usage.js";
import type { ItemRecord, RunRecord } from "./store.js";

export interface CostLedger {
  schema_version: "deepseek-harness.cost-ledger.v1";
  run_id: string;
  project: string;
  transport: string;
  model: string;
  cost_cap_usd: number;
  budget_reservation: Record<string, unknown> | null;
  estimated_usage: ReturnType<typeof estimateManifestUsage>;
  observed_usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    estimated_cost_usd: number | null;
    items_with_usage: number;
  };
  items: Array<{
    item_id: string;
    status: string;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    total_tokens: number | null;
    estimated_cost_usd: number | null;
    has_error: boolean;
  }>;
}

export function buildCostLedger(
  run: RunRecord,
  items: ItemRecord[],
  budgetReservation: Record<string, unknown> | null = null
): CostLedger {
  const rows = items.map((item) => {
    const usage = normaliseUsage(item.usage);
    return {
      item_id: item.item_id,
      status: item.status,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      estimated_cost_usd: usage.estimated_cost_usd,
      has_error: Boolean(item.error)
    };
  });

  const observedCost = rows.reduce<number | null>((total, item) => {
    if (item.estimated_cost_usd === null) {
      return total;
    }
    return (total ?? 0) + item.estimated_cost_usd;
  }, null);

  return {
    schema_version: "deepseek-harness.cost-ledger.v1",
    run_id: run.run_id,
    project: run.manifest.project,
    transport: run.manifest.transport,
    model: run.manifest.model,
    cost_cap_usd: run.manifest.cost_cap_usd,
    budget_reservation: budgetReservation,
    estimated_usage: estimateManifestUsage(run.manifest),
    observed_usage: {
      prompt_tokens: sumNumbers(rows.map((item) => item.prompt_tokens)),
      completion_tokens: sumNumbers(rows.map((item) => item.completion_tokens)),
      total_tokens: sumNumbers(rows.map((item) => item.total_tokens)),
      estimated_cost_usd: observedCost,
      items_with_usage: rows.filter((item) => item.total_tokens !== null).length
    },
    items: rows
  };
}

function normaliseUsage(usage: unknown): {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  estimated_cost_usd: number | null;
} {
  if (!usage || typeof usage !== "object") {
    return { prompt_tokens: null, completion_tokens: null, total_tokens: null, estimated_cost_usd: null };
  }
  const record = usage as Record<string, unknown>;
  return {
    prompt_tokens: numberOrNull(record.prompt_tokens),
    completion_tokens: numberOrNull(record.completion_tokens),
    total_tokens: numberOrNull(record.total_tokens),
    estimated_cost_usd: numberOrNull(record.estimated_cost_usd)
  };
}

function sumNumbers(values: Array<number | null>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
