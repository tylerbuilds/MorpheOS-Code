#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import packageMetadata from "../package.json" with { type: "json" };

function parseArgs(argv) {
  const args = {
    command: "node",
    commandArgs: ["dist/src/mcp.js"],
    profile: "full"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--command") {
      if (!argv[index + 1]) {
        throw new Error("Missing value for --command");
      }
      args.command = argv[index + 1];
      args.commandArgs = [];
      index += 1;
    } else if (value === "--") {
      args.commandArgs = argv.slice(index + 1);
      break;
    } else if (value === "--arg") {
      if (!argv[index + 1]) {
        throw new Error("Missing value for --arg");
      }
      args.commandArgs.push(argv[index + 1]);
      index += 1;
    } else if (value === "--profile") {
      const profile = argv[index + 1];
      if (!profile || !["core", "corpus", "full"].includes(profile)) {
        throw new Error("--profile must be core, corpus, or full");
      }
      args.profile = profile;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  return args;
}

const args = parseArgs(process.argv.slice(2));
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-mcp-smoke-"));
const transport = new StdioClientTransport({
  command: args.command,
  args: args.commandArgs,
  cwd: process.cwd(),
  env: {
    ...process.env,
    DEEPSEEK_HARNESS_MCP_PROFILE: args.profile,
    DEEPSEEK_HARNESS_STATE_DIR: path.join(smokeRoot, ".state"),
    DEEPSEEK_HARNESS_ARTIFACT_DIR: path.join(smokeRoot, "artifacts"),
    DEEPSEEK_HARNESS_INPUT_ROOT: smokeRoot
  }
});

const client = new Client(
  {
    name: "deepseek-harness-smoke",
    version: packageMetadata.version
  },
  {
    capabilities: {}
  }
);

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name).sort();
  const requiredTools = [
    "deepseek_harness_capabilities",
    "deepseek_harness_quickstart",
    "deepseek_harness_doctor",
    ...(args.profile === "corpus" ? ["deepseek_harness_corpus_ingest_text", "deepseek_harness_corpus_plan"] : [
    "deepseek_harness_plan",
    "deepseek_harness_submit",
    "deepseek_harness_work",
    "deepseek_harness_status",
    "deepseek_harness_results",
    "deepseek_harness_cancel",
    "deepseek_harness_export_review_packet",
    "deepseek_harness_state",
    "deepseek_harness_privacy_check",
    "deepseek_harness_cost_ledger",
    "deepseek_harness_dispatch_proposal",
    "deepseek_harness_approval_packet",
    "deepseek_harness_agent_canary",
    "deepseek_harness_workload_benchmark",
    "deepseek_harness_failure_canary",
    "deepseek_harness_compare_models",
    "deepseek_harness_scale_ramp"
    ]),
    ...(args.profile === "full" ? ["deepseek_harness_corpus_ingest_text", "deepseek_harness_corpus_plan"] : [])
  ];
  const missing = requiredTools.filter((tool) => !toolNames.includes(tool));
  if (missing.length > 0) {
    throw new Error(`Missing MCP tools: ${missing.join(", ")}`);
  }

  const doctor = await client.callTool({
    name: "deepseek_harness_doctor",
    arguments: {}
  });
  const doctorText = doctor.content?.find((item) => item.type === "text")?.text;
  const doctorPayload = doctorText ? JSON.parse(doctorText) : null;
  if (!doctorPayload?.ok) {
    throw new Error(`Doctor did not return ok payload: ${doctorText ?? "(missing text content)"}`);
  }

  const capabilities = await client.callTool({
    name: "deepseek_harness_capabilities",
    arguments: {}
  });
  const capabilitiesText = capabilities.content?.find((item) => item.type === "text")?.text;
  const capabilitiesPayload = capabilitiesText ? JSON.parse(capabilitiesText) : null;
  if (!capabilitiesPayload?.ok || capabilitiesPayload.active_mcp_profile !== args.profile) {
    throw new Error(`Capabilities did not report profile ${args.profile}: ${capabilitiesText ?? "(missing text content)"}`);
  }

  console.log(JSON.stringify({
    ok: true,
    profile: args.profile,
    tool_count: toolNames.length,
    tools: toolNames,
    doctor: doctorPayload,
    capabilities_schema: capabilitiesPayload.schema_version
  }, null, 2));
} finally {
  await client.close();
  fs.rmSync(smokeRoot, { recursive: true, force: true });
}
