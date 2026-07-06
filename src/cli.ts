#!/usr/bin/env node
import fs from "node:fs";
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
  mcpConfig,
  mcpConfigToml,
  modelComparisonPlan,
  planManifest,
  privacyCheck,
  processRun,
  scaleRamp,
  submitManifest,
  workloadBenchmark
} from "./runner.js";
import { toErrorPayload } from "./errors.js";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const allowLive = Boolean(args.flags["allow-live"]);

  let result: unknown;
  let rawOutput: string | undefined;
  switch (args.command) {
    case "doctor":
      result = doctor();
      break;
    case "mcp-config":
      {
        const options = {
          command: optionalString(args.flags.command),
          stateDir: optionalString(args.flags["state-dir"]),
          artifactDir: optionalString(args.flags["artifact-dir"])
        };
        const format = optionalString(args.flags.format) ?? "json";
        if (format === "json") {
          result = mcpConfig(options);
        } else if (format === "codex-toml") {
          rawOutput = mcpConfigToml(options);
        } else {
          throw new Error(`Unknown mcp-config format: ${format}`);
        }
      }
      break;
    case "plan":
      result = planManifest(readJson(requiredArg(args, 0, "manifest path")), { allowLive });
      break;
    case "submit":
      result = await submitManifest(readJson(requiredArg(args, 0, "manifest path")), {}, {
        start: Boolean(args.flags.start),
        allowLive
      });
      break;
    case "work":
      result = await processRun(requiredFlagOrArg(args, "run", 0), {}, { allowLive });
      break;
    case "status":
      result = getStatus(requiredArg(args, 0, "run_id"));
      break;
    case "results":
      result = getResults(requiredArg(args, 0, "run_id"));
      break;
    case "cancel":
      result = cancelRun(requiredArg(args, 0, "run_id"));
      break;
    case "export-review-packet":
      result = exportReviewPacket(requiredArg(args, 0, "run_id"));
      break;
    case "state":
      result = args.flags.output
        ? exportHarnessState({}, { output: String(args.flags.output), limit: optionalNumber(args.flags.limit) })
        : harnessState({}, { limit: optionalNumber(args.flags.limit) });
      break;
    case "privacy-check":
      result = privacyCheck(readJson(requiredArg(args, 0, "manifest path")));
      break;
    case "cost-ledger":
      result = exportCostLedger(requiredArg(args, 0, "run_id"), {}, { output: optionalString(args.flags.output) });
      break;
    case "dispatch-proposal":
      result = dispatchProposal(readJson(requiredArg(args, 0, "manifest path")), { allowLive });
      break;
    case "approval-packet":
      result = args.flags.output
        ? exportApprovalPacket(readJson(requiredArg(args, 0, "manifest path")), {}, { output: String(args.flags.output) })
        : approvalPacket(readJson(requiredArg(args, 0, "manifest path")));
      break;
    case "scale-ramp":
      result = await scaleRamp(readJson(requiredArg(args, 0, "manifest path")), {}, {
        concurrencies: optionalNumberList(args.flags.concurrency),
        itemCount: optionalNumber(args.flags.items),
        output: optionalString(args.flags.output),
        allowLive,
        allowLiveScale: Boolean(args.flags["allow-live-scale"])
      });
      break;
    case "agent-canary":
      result = await agentCanary({}, { output: optionalString(args.flags.output) });
      break;
    case "workload-benchmark":
      result = await workloadBenchmark({}, {
        workload: optionalString(args.flags.workload),
        items: optionalNumber(args.flags.items),
        concurrency: optionalNumber(args.flags.concurrency),
        transport: optionalLocalTransport(args.flags.transport),
        model: optionalModel(args.flags.model),
        output: optionalString(args.flags.output)
      });
      break;
    case "failure-canary":
      result = await failureCanary({}, { output: optionalString(args.flags.output) });
      break;
    case "compare-models":
      result = modelComparisonPlan(readJson(requiredArg(args, 0, "manifest path")), {
        models: optionalModelList(args.flags.models),
        transport: optionalLocalTransport(args.flags.transport),
        output: optionalString(args.flags.output)
      });
      break;
    default:
      throw new Error(`Unknown command: ${args.command || "(missing)"}`);
  }

  process.stdout.write(rawOutput ?? `${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value.startsWith("--")) {
      const key = value.slice(2);
      const next = rest[index + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(value);
    }
  }

  return { command, positional, flags };
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function requiredArg(args: ParsedArgs, index: number, label: string): string {
  const value = args.positional[index];
  if (!value) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function requiredFlagOrArg(args: ParsedArgs, flag: string, index: number): string {
  const fromFlag = args.flags[flag];
  if (typeof fromFlag === "string") {
    return fromFlag;
  }
  return requiredArg(args, index, flag);
}

function optionalNumber(value: string | boolean | undefined): number | undefined {
  if (value === undefined || typeof value === "boolean") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected number, got ${value}`);
  }
  return parsed;
}

function optionalString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumberList(value: string | boolean | undefined): number[] | undefined {
  if (value === undefined || typeof value === "boolean") {
    return undefined;
  }
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (parts.some((part) => !Number.isFinite(part) || part <= 0 || !Number.isInteger(part))) {
    throw new Error(`Expected comma-separated positive integers, got ${value}`);
  }
  return parts;
}

function optionalLocalTransport(value: string | boolean | undefined): "fake" | "dry-run" | undefined {
  if (value === undefined || typeof value === "boolean") {
    return undefined;
  }
  if (value === "fake" || value === "dry-run") {
    return value;
  }
  throw new Error(`Expected fake or dry-run transport, got ${value}`);
}

function optionalModel(value: string | boolean | undefined): "deepseek-v4-flash" | "deepseek-v4-pro" | undefined {
  if (value === undefined || typeof value === "boolean") {
    return undefined;
  }
  if (value === "deepseek-v4-flash" || value === "deepseek-v4-pro") {
    return value;
  }
  throw new Error(`Expected DeepSeek V4 model, got ${value}`);
}

function optionalModelList(value: string | boolean | undefined): Array<"deepseek-v4-flash" | "deepseek-v4-pro"> | undefined {
  if (value === undefined || typeof value === "boolean") {
    return undefined;
  }
  return value.split(",").map((part) => {
    const model = optionalModel(part.trim());
    if (!model) {
      throw new Error(`Expected DeepSeek V4 model, got ${part}`);
    }
    return model;
  });
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify(toErrorPayload(error), null, 2)}\n`);
  process.exitCode = 1;
});
