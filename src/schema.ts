import { z } from "zod";
import { HarnessError } from "./errors.js";
import { classifyManifestPrivacy, type PrivacyReport } from "./privacy.js";
import { estimateManifestUsage, type UsageEstimate } from "./usage.js";

export const LIVE_CONCURRENCY_CAP = 20;
export const PREVIEW_CONCURRENCY_CAP = 100;
export const LIVE_COST_CAP_USD = 5;

export const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().min(1)
});

export const runItemSchema = z
  .object({
    id: z.string().min(1).regex(/^[A-Za-z0-9_.:-]+$/),
    prompt: z.string().min(1).optional(),
    messages: z.array(messageSchema).min(1).optional(),
    metadata: z.record(z.unknown()).optional()
  })
  .refine((item) => Boolean(item.prompt) || Boolean(item.messages), {
    message: "Each item must include either prompt or messages"
  });

export const thinkingSchema = z.object({
  type: z.enum(["enabled", "disabled"]).default("enabled"),
  reasoning_effort: z.enum(["high", "max"]).optional()
});

export const failureInjectionSchema = z
  .object({
    fail_item_ids: z.array(z.string().min(1)).optional(),
    fail_every_n: z.number().int().positive().optional(),
    error_message: z.string().min(1).max(500).optional()
  })
  .refine((value) => Boolean(value.fail_item_ids?.length) || Boolean(value.fail_every_n), {
    message: "failure_injection requires fail_item_ids or fail_every_n"
  });

export const runManifestSchema = z.object({
  schema_version: z.literal("deepseek-harness.run.v1"),
  run_id: z.string().min(1).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
  project: z.string().min(1),
  description: z.string().optional(),
  egress_class: z.enum([
    "non_sensitive_bulk",
    "local_private",
    "personal_sensitive",
    "client_sensitive",
    "health_genetics",
    "secrets_or_credentials"
  ]),
  transport: z.enum(["fake", "dry-run", "deepseek"]).default("fake"),
  model: z.enum(["deepseek-v4-flash", "deepseek-v4-pro"]).default("deepseek-v4-flash"),
  thinking: thinkingSchema.default({ type: "enabled" }),
  response_format: z.enum(["text", "json_object"]).default("text"),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(384000).optional(),
  concurrency: z.number().int().positive().max(PREVIEW_CONCURRENCY_CAP),
  cost_cap_usd: z.number().positive().max(100),
  approval_id: z.string().min(1).optional(),
  artifact_dir: z.string().min(1).optional(),
  canonical_writes: z.literal(false).default(false),
  external_side_effects: z.literal(false).default(false),
  workload_profile: z.string().min(1).optional(),
  failure_injection: failureInjectionSchema.optional(),
  items: z.array(runItemSchema).min(1).max(10000)
});

export type RunManifest = z.infer<typeof runManifestSchema>;
export type RunItem = z.infer<typeof runItemSchema>;
export type Message = z.infer<typeof messageSchema>;

export type ExecutionMode = "plan" | "queued" | "execute";

export interface ExecutionPlan {
  ok: boolean;
  mode: ExecutionMode;
  project: string;
  transport: RunManifest["transport"];
  model: RunManifest["model"];
  item_count: number;
  concurrency: number;
  cost_cap_usd: number;
  live_call_requested: boolean;
  privacy: PrivacyReport;
  estimated_usage: UsageEstimate;
  blockers: string[];
  warnings: string[];
}

export function parseManifest(input: unknown): RunManifest {
  const parsed = runManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new HarnessError("invalid_manifest", "Run manifest failed validation", parsed.error.flatten());
  }

  return parsed.data;
}

export function buildExecutionPlan(
  manifest: RunManifest,
  options: { mode: ExecutionMode; allowLive?: boolean; apiKeyPresent?: boolean } = { mode: "plan" }
): ExecutionPlan {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const liveCallRequested = manifest.transport === "deepseek";
  const privacy = classifyManifestPrivacy(manifest);
  const estimatedUsage = estimateManifestUsage(manifest);

  if (manifest.canonical_writes !== false) {
    blockers.push("canonical_writes_must_be_false");
  }

  if (manifest.external_side_effects !== false) {
    blockers.push("external_side_effects_must_be_false");
  }

  if (manifest.transport === "dry-run") {
    warnings.push("deepseek_request_shape_only_no_network_call");
  }

  if (manifest.failure_injection) {
    if (manifest.transport === "deepseek") {
      blockers.push("failure_injection_not_allowed_for_live_deepseek");
    } else {
      warnings.push("failure_injection_enabled_for_local_transport");
    }
  }

  if (manifest.egress_class !== "non_sensitive_bulk") {
    if (manifest.transport === "deepseek") {
      blockers.push("external_deepseek_requires_non_sensitive_bulk_egress");
    } else {
      warnings.push("non_external_transport_selected_for_sensitive_or_private_egress");
    }
  }

  if (privacy.recommended_egress_class !== "non_sensitive_bulk") {
    warnings.push(`privacy_classifier_recommends_${privacy.recommended_egress_class}`);
    if (manifest.transport === "deepseek") {
      blockers.push("privacy_classifier_blocks_external_deepseek");
    }
  }

  if (liveCallRequested) {
    if (!options.allowLive) {
      blockers.push("live_deepseek_call_not_enabled_by_caller");
    }
    if (!manifest.approval_id) {
      blockers.push("approval_id_required_for_live_deepseek");
    } else if (isPlaceholderApprovalId(manifest.approval_id)) {
      blockers.push("approval_id_placeholder_not_allowed");
    }
    if (manifest.concurrency > LIVE_CONCURRENCY_CAP) {
      blockers.push(`live_concurrency_cap_exceeded_${LIVE_CONCURRENCY_CAP}`);
    }
    if (manifest.cost_cap_usd > LIVE_COST_CAP_USD) {
      blockers.push(`live_cost_cap_exceeded_${LIVE_COST_CAP_USD}`);
    }
    if (!options.apiKeyPresent) {
      blockers.push("deepseek_api_key_not_present");
    }
  }

  if (manifest.response_format === "json_object") {
    warnings.push("json_output_requires_prompt_instruction_to_return_json");
  }

  return {
    ok: blockers.length === 0,
    mode: options.mode,
    project: manifest.project,
    transport: manifest.transport,
    model: manifest.model,
    item_count: manifest.items.length,
    concurrency: manifest.concurrency,
    cost_cap_usd: manifest.cost_cap_usd,
    live_call_requested: liveCallRequested,
    privacy,
    estimated_usage: estimatedUsage,
    blockers,
    warnings
  };
}

export function assertPlanExecutable(plan: ExecutionPlan): void {
  if (!plan.ok) {
    throw new HarnessError("blocked_by_safety_policy", "Run is blocked by harness safety policy", plan);
  }
}

export function isPlaceholderApprovalId(approvalId: string): boolean {
  return /^(approval-id-goes-here|replace-me|todo|tbd|pending)$/i.test(approvalId.trim());
}
