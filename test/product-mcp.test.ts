import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpProfile } from "../src/product.js";

const localWriteTools = new Set([
  "deepseek_harness_quickstart",
  "deepseek_harness_submit",
  "deepseek_harness_work",
  "deepseek_harness_cancel",
  "deepseek_harness_corpus_approval_packet",
  "deepseek_harness_corpus_start",
  "deepseek_harness_corpus_resume",
  "deepseek_harness_corpus_work",
  "deepseek_harness_corpus_reconcile",
  "deepseek_harness_corpus_cancel",
  "deepseek_harness_corpus_commit_translation_memory",
  "deepseek_harness_corpus_supervise",
  "deepseek_harness_export_review_packet",
  "deepseek_harness_state",
  "deepseek_harness_cost_ledger",
  "deepseek_harness_approval_packet",
  "deepseek_harness_agent_canary",
  "deepseek_harness_workload_benchmark",
  "deepseek_harness_failure_canary",
  "deepseek_harness_compare_models",
  "deepseek_harness_scale_ramp",
  "morpheos_chat"
]);

const liveCapableTools = new Set([
  "deepseek_harness_submit",
  "deepseek_harness_work",
  "deepseek_harness_corpus_start",
  "deepseek_harness_corpus_resume",
  "deepseek_harness_corpus_work",
  "deepseek_harness_scale_ramp",
  "morpheos_chat"
]);

type JsonSchema = {
  readonly type?: string;
  readonly const?: unknown;
  readonly additionalProperties?: boolean;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
};

type McpResponse = {
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly structuredContent?: Record<string, unknown>;
};

async function connect(profile: McpProfile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `deepseek-product-mcp-${profile}-`));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/src/mcp.js"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEEPSEEK_HARNESS_MCP_PROFILE: profile,
      DEEPSEEK_HARNESS_STATE_DIR: path.join(root, ".state"),
      DEEPSEEK_HARNESS_ARTIFACT_DIR: path.join(root, "artifacts"),
      DEEPSEEK_HARNESS_INPUT_ROOT: root
    }
  });
  const client = new Client({ name: `deepseek-product-${profile}`, version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return { client, root };
}

function parseJsonContent(response: unknown): Record<string, unknown> {
  const content = (response as { content?: Array<{ type: string; text?: string }> }).content;
  const text = content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("MCP response did not include JSON text content");
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function structuredJsonContent(response: unknown): Record<string, unknown> {
  const structuredContent = (response as McpResponse).structuredContent;
  if (!structuredContent || typeof structuredContent !== "object" || Array.isArray(structuredContent)) {
    throw new Error("MCP response did not include structured JSON content");
  }
  return structuredContent;
}

function manifestSchema(response: { inputSchema: { properties?: Record<string, object> } }): JsonSchema {
  const manifest = response.inputSchema.properties?.manifest;
  assert.ok(manifest);
  return manifest as JsonSchema;
}

test("MCP profiles expose compact, specialised and backwards-compatible tool sets", async () => {
  for (const profile of ["core", "corpus", "full"] as const) {
    const { client } = await connect(profile);
    try {
      const tools = await client.listTools();
      const names = new Set(tools.tools.map((tool) => tool.name));
      assert.equal(names.has("deepseek_harness_capabilities"), true, profile);
      assert.equal(names.has("deepseek_harness_quickstart"), true, profile);
      assert.equal(names.has("deepseek_harness_doctor"), true, profile);
      assert.equal(names.has("deepseek_harness_plan"), profile !== "corpus", profile);
      assert.equal(names.has("deepseek_harness_corpus_ingest_text"), profile !== "core", profile);

      for (const tool of tools.tools) {
        assert.deepEqual(tool.annotations, {
          readOnlyHint: !localWriteTools.has(tool.name),
          destructiveHint: localWriteTools.has(tool.name),
          idempotentHint: !localWriteTools.has(tool.name),
          openWorldHint: liveCapableTools.has(tool.name)
        }, tool.name);
      }

      for (const name of [
        "deepseek_harness_capabilities",
        "deepseek_harness_quickstart",
        "deepseek_harness_doctor"
      ]) {
        const tool = tools.tools.find((candidate) => candidate.name === name);
        assert.ok(tool, `${name} should be registered`);
        assert.equal(tool.outputSchema?.type, "object", `${name} should advertise an output schema`);
      }

      if (profile === "corpus") {
        const corpusPlan = tools.tools.find((tool) => tool.name === "deepseek_harness_corpus_plan");
        assert.ok(corpusPlan);
        const schema = manifestSchema(corpusPlan);
        assert.equal(schema.properties?.schema_version?.const, "deepseek-harness.corpus.v1");
        assert.equal(schema.properties?.sources?.type, "array");
        assert.equal(schema.properties?.shards?.type, "array");
        assert.equal(schema.additionalProperties, true);
      } else {
        const runPlan = tools.tools.find((tool) => tool.name === "deepseek_harness_plan");
        assert.ok(runPlan);
        const schema = manifestSchema(runPlan);
        assert.equal(schema.properties?.schema_version?.const, "deepseek-harness.run.v1");
        assert.equal(schema.properties?.items?.type, "array");
        assert.equal(schema.properties?.egress_class?.type, "string");
        assert.equal(schema.additionalProperties, true);
      }

      const capabilitiesResponse = await client.callTool({
        name: "deepseek_harness_capabilities",
        arguments: {}
      });
      const capabilities = parseJsonContent(capabilitiesResponse) as {
        active_mcp_profile?: string;
        workflows?: Array<{ id: string }>;
      };
      assert.deepEqual(structuredJsonContent(capabilitiesResponse), capabilities);
      assert.equal(capabilities.active_mcp_profile, profile);
      assert.equal(capabilities.workflows?.some((workflow) => workflow.id === "run_safe_batch"), true);

      const doctorResponse = await client.callTool({ name: "deepseek_harness_doctor", arguments: {} });
      const doctor = parseJsonContent(doctorResponse);
      assert.deepEqual(structuredJsonContent(doctorResponse), doctor);
    } finally {
      await client.close();
    }
  }
});

test("MCP quickstart proves a zero-network run and returns durable artefacts", async () => {
  const { client, root } = await connect("core");
  try {
    const output = path.join(root, "artifacts", "mcp-quickstart.json");
    const response = await client.callTool({
      name: "deepseek_harness_quickstart",
      arguments: { output }
    });
    const payload = parseJsonContent(response) as {
      ok?: boolean;
      status?: string;
      network_calls?: number;
      canary?: { report?: { artefacts?: { review_packet?: string; cost_ledger?: string } } };
    };

    assert.equal(response.isError, false);
    assert.deepEqual(structuredJsonContent(response), payload);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "ready");
    assert.equal(payload.network_calls, 0);
    assert.equal(fs.existsSync(output), true);
    assert.equal(fs.existsSync(payload.canary?.report?.artefacts?.review_packet ?? ""), true);
    assert.equal(fs.existsSync(payload.canary?.report?.artefacts?.cost_ledger ?? ""), true);
  } finally {
    await client.close();
  }
});

test("MCP marks failed tool calls as protocol errors with structured payloads", async () => {
  const { client } = await connect("core");
  try {
    const response = await client.callTool({
      name: "deepseek_harness_status",
      arguments: { run_id: "missing-run" }
    });
    const payload = parseJsonContent(response) as { ok?: boolean; code?: string; message?: string };

    assert.equal(response.isError, true);
    assert.deepEqual(structuredJsonContent(response), payload);
    assert.equal(payload.ok, false);
    assert.equal(typeof payload.code, "string");
    assert.match(payload.message ?? "", /not found/i);
  } finally {
    await client.close();
  }
});
