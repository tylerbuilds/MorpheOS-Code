import type { RunManifest } from "./schema.js";

export type LocalTransport = "fake" | "dry-run";

export interface BenchmarkOptions {
  project?: string;
  workload?: string;
  items?: number;
  concurrency?: number;
  transport?: LocalTransport;
  model?: RunManifest["model"];
  artifactDir?: string;
}

export interface WorkloadTemplate {
  name: string;
  description: string;
  response_format: RunManifest["response_format"];
  prompts: string[];
}

export const WORKLOAD_TEMPLATES: Record<string, WorkloadTemplate> = {
  classification: {
    name: "classification",
    description: "Route short inputs into labelled categories.",
    response_format: "json_object",
    prompts: [
      "Classify this support request as billing, technical, content, or other: The report export button is disabled.",
      "Classify this content brief as educate, compare, explain, or persuade: A patient guide to safe clinic questions.",
      "Classify this repo task as bug, feature, docs, or test: Add failure injection to the batch runner."
    ]
  },
  extraction: {
    name: "extraction",
    description: "Extract structured fields from short text.",
    response_format: "json_object",
    prompts: [
      "Extract title, owner, due_date, and risk from: Write MCP install guide, owner platform, due Friday, medium risk.",
      "Extract company, product, pain, and next_action from: Acme needs faster article drafting; trial batch benchmark next.",
      "Extract entity, status, blocker, and proof from: DeepSeek Harness green locally, no live run approved, npm test passed."
    ]
  },
  scoring: {
    name: "scoring",
    description: "Score candidate outputs against compact rubrics.",
    response_format: "json_object",
    prompts: [
      "Score this answer for directness, evidence, and next action: The docs seem mostly fine and probably work.",
      "Score this article plan for patient usefulness and compliance caution: It lists benefits but misses eligibility.",
      "Score this run report for proof quality: Tests passed, but exact commands and side effects are missing."
    ]
  },
  summarisation: {
    name: "summarisation",
    description: "Summarise operational text into action-oriented notes.",
    response_format: "text",
    prompts: [
      "Summarise this update in three operational bullets: local tests passed, MCP smoke passed, no external calls made.",
      "Summarise this brief for an agent handoff: implement canary, benchmark, privacy, and model comparison locally.",
      "Summarise this risk note: live model calls need approval, non-sensitive egress, cost cap, API key, and live flags."
    ]
  },
  drafting: {
    name: "drafting",
    description: "Draft concise first-pass content from safe public topics.",
    response_format: "text",
    prompts: [
      "Draft a short patient-friendly introduction to preparing questions for a medical cannabis clinic.",
      "Draft a concise README paragraph explaining a local-first batch inference harness.",
      "Draft a neutral checklist for reviewing generated article drafts before publication."
    ]
  },
  second_opinion: {
    name: "second_opinion",
    description: "Give a critical second pass on an agent's proposed answer.",
    response_format: "json_object",
    prompts: [
      "Review this claim and identify missing proof: The MCP server is ready because the files exist.",
      "Review this plan and identify scale risks: Run 500 live calls immediately at maximum concurrency.",
      "Review this content workflow and identify editorial risks: Publish all drafts without human review."
    ]
  }
};

export function buildAgentCanaryManifest(options: BenchmarkOptions = {}): RunManifest {
  return {
    schema_version: "deepseek-harness.run.v1",
    project: options.project ?? "deepseek-harness-agent-canary",
    description: "Local fake agent usability canary for CLI/MCP consumers.",
    egress_class: "non_sensitive_bulk",
    transport: options.transport ?? "fake",
    model: options.model ?? "deepseek-v4-flash",
    thinking: { type: "enabled" },
    response_format: "json_object",
    concurrency: options.concurrency ?? 3,
    cost_cap_usd: 0.05,
    artifact_dir: options.artifactDir,
    canonical_writes: false,
    external_side_effects: false,
    workload_profile: "agent_canary",
    items: [
      {
        id: "canary-plan",
        prompt: "Return JSON with readiness, missing_inputs, and next_action for a local DeepSeek harness canary."
      },
      {
        id: "canary-safety",
        prompt: "Return JSON listing blocked side effects for a local batch inference harness."
      },
      {
        id: "canary-proof",
        prompt: "Return JSON with the proof artefacts an agent should inspect after a harness run."
      }
    ]
  };
}

export function buildFailureCanaryManifest(options: BenchmarkOptions = {}): RunManifest {
  return {
    schema_version: "deepseek-harness.run.v1",
    project: options.project ?? "deepseek-harness-failure-canary",
    description: "Local failure-injection canary for partial-run behaviour.",
    egress_class: "non_sensitive_bulk",
    transport: options.transport ?? "fake",
    model: options.model ?? "deepseek-v4-flash",
    thinking: { type: "disabled" },
    response_format: "json_object",
    concurrency: options.concurrency ?? 2,
    cost_cap_usd: 0.05,
    artifact_dir: options.artifactDir,
    canonical_writes: false,
    external_side_effects: false,
    workload_profile: "failure_canary",
    failure_injection: {
      fail_item_ids: ["failure-2"],
      error_message: "Injected local canary failure"
    },
    items: [
      { id: "failure-1", prompt: "Return JSON acknowledging successful item one." },
      { id: "failure-2", prompt: "Return JSON acknowledging this item should be failed by injection." },
      { id: "failure-3", prompt: "Return JSON acknowledging successful item three." },
      { id: "failure-4", prompt: "Return JSON acknowledging successful item four." }
    ]
  };
}

export function buildWorkloadBenchmarkManifest(options: BenchmarkOptions = {}): RunManifest {
  const template = WORKLOAD_TEMPLATES[normaliseWorkload(options.workload)];
  const itemCount = options.items ?? Math.max(template.prompts.length, 6);
  return {
    schema_version: "deepseek-harness.run.v1",
    project: options.project ?? `deepseek-harness-benchmark-${template.name}`,
    description: template.description,
    egress_class: "non_sensitive_bulk",
    transport: options.transport ?? "fake",
    model: options.model ?? "deepseek-v4-flash",
    thinking: { type: "enabled" },
    response_format: template.response_format,
    concurrency: options.concurrency ?? Math.min(10, itemCount),
    cost_cap_usd: 0.1,
    artifact_dir: options.artifactDir,
    canonical_writes: false,
    external_side_effects: false,
    workload_profile: template.name,
    items: Array.from({ length: itemCount }, (_, index) => ({
      id: `${template.name}-${index + 1}`,
      prompt: template.prompts[index % template.prompts.length],
      metadata: {
        workload: template.name,
        prompt_index: index % template.prompts.length
      }
    }))
  };
}

export function listWorkloads(): Array<Pick<WorkloadTemplate, "name" | "description" | "response_format">> {
  return Object.values(WORKLOAD_TEMPLATES).map(({ name, description, response_format }) => ({
    name,
    description,
    response_format
  }));
}

function normaliseWorkload(workload: string | undefined): string {
  const key = (workload ?? "classification").trim().toLowerCase().replace(/-/g, "_");
  if (!WORKLOAD_TEMPLATES[key]) {
    throw new Error(`Unknown benchmark workload: ${workload ?? "(missing)"}`);
  }
  return key;
}
