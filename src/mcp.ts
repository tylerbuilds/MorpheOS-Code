#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  agentCanary,
  cancelRun,
  approvalPacket,
  dispatchProposal,
  doctor,
  exportCostLedger,
  exportApprovalPacket,
  exportHarnessState,
  exportReviewPacket,
  failureCanary,
  getResults,
  getStatus,
  harnessState,
  modelComparisonPlan,
  planManifest,
  privacyCheck,
  processRun,
  scaleRamp,
  submitManifest,
  workloadBenchmark
} from "./runner.js";
import { toErrorPayload } from "./errors.js";

const server = new McpServer({
  name: "deepseek-harness",
  version: "0.1.0"
});

function jsonContent(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

async function wrap(fn: () => unknown | Promise<unknown>) {
  try {
    return jsonContent(await fn());
  } catch (error) {
    return jsonContent(toErrorPayload(error));
  }
}

server.registerTool(
  "deepseek_harness_doctor",
  {
    title: "DeepSeek Harness Doctor",
    description: "Check local harness state without exposing secrets.",
    inputSchema: {}
  },
  async () => wrap(() => doctor())
);

server.registerTool(
  "deepseek_harness_plan",
  {
    title: "DeepSeek Harness Plan",
    description: "Validate a run manifest and return safety blockers or warnings.",
    inputSchema: {
      manifest: z.record(z.unknown()),
      allow_live: z.boolean().optional()
    }
  },
  async ({ manifest, allow_live }) => wrap(() => planManifest(manifest, { allowLive: allow_live }))
);

server.registerTool(
  "deepseek_harness_submit",
  {
    title: "DeepSeek Harness Submit",
    description: "Create a run and optionally start it. Live calls require allow_live and a valid approval packet.",
    inputSchema: {
      manifest: z.record(z.unknown()),
      start: z.boolean().optional(),
      allow_live: z.boolean().optional()
    }
  },
  async ({ manifest, start, allow_live }) =>
    wrap(() => submitManifest(manifest, {}, { start: Boolean(start), allowLive: Boolean(allow_live) }))
);

server.registerTool(
  "deepseek_harness_work",
  {
    title: "DeepSeek Harness Work",
    description: "Process a queued run by run_id.",
    inputSchema: {
      run_id: z.string().min(1),
      allow_live: z.boolean().optional()
    }
  },
  async ({ run_id, allow_live }) => wrap(() => processRun(run_id, {}, { allowLive: Boolean(allow_live) }))
);

server.registerTool(
  "deepseek_harness_status",
  {
    title: "DeepSeek Harness Status",
    description: "Get a run summary by run_id.",
    inputSchema: {
      run_id: z.string().min(1)
    }
  },
  async ({ run_id }) => wrap(() => getStatus(run_id))
);

server.registerTool(
  "deepseek_harness_results",
  {
    title: "DeepSeek Harness Results",
    description: "Get run results by run_id.",
    inputSchema: {
      run_id: z.string().min(1)
    }
  },
  async ({ run_id }) => wrap(() => getResults(run_id))
);

server.registerTool(
  "deepseek_harness_cancel",
  {
    title: "DeepSeek Harness Cancel",
    description: "Cancel queued or running work for a run_id.",
    inputSchema: {
      run_id: z.string().min(1)
    }
  },
  async ({ run_id }) => wrap(() => cancelRun(run_id))
);

server.registerTool(
  "deepseek_harness_export_review_packet",
  {
    title: "DeepSeek Harness Export Review Packet",
    description: "Write and return the local review packet for a run.",
    inputSchema: {
      run_id: z.string().min(1)
    }
  },
  async ({ run_id }) => wrap(() => exportReviewPacket(run_id))
);

server.registerTool(
  "deepseek_harness_state",
  {
    title: "DeepSeek Harness State",
    description: "Return or export a read-model snapshot. Direct Command Centre state writes are blocked.",
    inputSchema: {
      output: z.string().optional(),
      limit: z.number().int().positive().optional()
    }
  },
  async ({ output, limit }) =>
    wrap(() => (output ? exportHarnessState({}, { output, limit }) : harnessState({}, { limit })))
);

server.registerTool(
  "deepseek_harness_privacy_check",
  {
    title: "DeepSeek Harness Privacy Check",
    description: "Classify manifest egress risk without returning matched sensitive text.",
    inputSchema: {
      manifest: z.record(z.unknown())
    }
  },
  async ({ manifest }) => wrap(() => privacyCheck(manifest))
);

server.registerTool(
  "deepseek_harness_cost_ledger",
  {
    title: "DeepSeek Harness Cost Ledger",
    description: "Export token and cost ledger for an existing run.",
    inputSchema: {
      run_id: z.string().min(1),
      output: z.string().optional()
    }
  },
  async ({ run_id, output }) => wrap(() => exportCostLedger(run_id, {}, { output }))
);

server.registerTool(
  "deepseek_harness_dispatch_proposal",
  {
    title: "DeepSeek Harness Dispatch Proposal",
    description: "Return a Zeus Dispatch-compatible proposal packet without submitting or executing it.",
    inputSchema: {
      manifest: z.record(z.unknown()),
      allow_live: z.boolean().optional()
    }
  },
  async ({ manifest, allow_live }) => wrap(() => dispatchProposal(manifest, { allowLive: Boolean(allow_live) }))
);

server.registerTool(
  "deepseek_harness_approval_packet",
  {
    title: "DeepSeek Harness Approval Packet",
    description: "Prepare the explicit approval packet required before any live DeepSeek API call.",
    inputSchema: {
      manifest: z.record(z.unknown()),
      output: z.string().optional()
    }
  },
  async ({ manifest, output }) => wrap(() => (output ? exportApprovalPacket(manifest, {}, { output }) : approvalPacket(manifest)))
);

server.registerTool(
  "deepseek_harness_agent_canary",
  {
    title: "DeepSeek Harness Agent Canary",
    description: "Run a local fake canary proving CLI/MCP agent usability and artefact generation.",
    inputSchema: {
      output: z.string().optional()
    }
  },
  async ({ output }) => wrap(() => agentCanary({}, { output }))
);

server.registerTool(
  "deepseek_harness_workload_benchmark",
  {
    title: "DeepSeek Harness Workload Benchmark",
    description: "Run a local fake or dry-run benchmark workload pack.",
    inputSchema: {
      workload: z.string().optional(),
      items: z.number().int().positive().optional(),
      concurrency: z.number().int().positive().optional(),
      transport: z.enum(["fake", "dry-run"]).optional(),
      model: z.enum(["deepseek-v4-flash", "deepseek-v4-pro"]).optional(),
      output: z.string().optional()
    }
  },
  async ({ workload, items, concurrency, transport, model, output }) =>
    wrap(() => workloadBenchmark({}, { workload, items, concurrency, transport, model, output }))
);

server.registerTool(
  "deepseek_harness_failure_canary",
  {
    title: "DeepSeek Harness Failure Canary",
    description: "Run a local failure-injection canary and confirm partial failure reporting.",
    inputSchema: {
      output: z.string().optional()
    }
  },
  async ({ output }) => wrap(() => failureCanary({}, { output }))
);

server.registerTool(
  "deepseek_harness_compare_models",
  {
    title: "DeepSeek Harness Compare Models",
    description: "Prepare fake or dry-run comparison manifests for DeepSeek V4 Flash and Pro.",
    inputSchema: {
      manifest: z.record(z.unknown()),
      models: z.array(z.enum(["deepseek-v4-flash", "deepseek-v4-pro"])).optional(),
      transport: z.enum(["fake", "dry-run"]).optional(),
      output: z.string().optional()
    }
  },
  async ({ manifest, models, transport, output }) => wrap(() => modelComparisonPlan(manifest, { models, transport, output }))
);

server.registerTool(
  "deepseek_harness_scale_ramp",
  {
    title: "DeepSeek Harness Scale Ramp",
    description: "Run a bounded local scale ramp. Live DeepSeek scale requires allow_live and allow_live_scale.",
    inputSchema: {
      manifest: z.record(z.unknown()),
      concurrencies: z.array(z.number().int().positive()).optional(),
      items: z.number().int().positive().optional(),
      output: z.string().optional(),
      allow_live: z.boolean().optional(),
      allow_live_scale: z.boolean().optional()
    }
  },
  async ({ manifest, concurrencies, items, output, allow_live, allow_live_scale }) =>
    wrap(() =>
      scaleRamp(manifest, {}, {
        concurrencies,
        itemCount: items,
        output,
        allowLive: Boolean(allow_live),
        allowLiveScale: Boolean(allow_live_scale)
      })
    )
);

const transport = new StdioServerTransport();
await server.connect(transport);
