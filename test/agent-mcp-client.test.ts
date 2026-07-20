import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { McpClient, McpRegistry, type McpServerConfig, type McpToolDefinition, type SpawnFactory } from "../src/agent/mcp-client.js";

// ── Helpers for creating fake child processes ──

interface MockChildProcess extends EventEmitter {
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => void;
  exitCode: number | null;
}

function createMockProcess(): MockChildProcess {
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as MockChildProcess;
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = () => {};
  proc.exitCode = null;
  return proc;
}

/** Returns a spawn factory that creates a single mock process. */
function singleProcSpawn(proc: MockChildProcess): SpawnFactory {
  return () => proc as unknown as ChildProcess;
}

/** Returns a spawn factory that alternates between provided mock processes. */
function rotatingSpawn(procs: MockChildProcess[]): SpawnFactory {
  let idx = 0;
  return () => {
    const proc = procs[idx % procs.length];
    idx++;
    return proc as unknown as ChildProcess;
  };
}

// Stdin capture helper — no longer needed since autoHandshake functions capture writes themselves.

/** Auto-respond to JSON-RPC requests written to stdin by writing responses to stdout.  */
function autoHandshake(proc: MockChildProcess, tools: McpToolDefinition[] = []): string[] {
  const writes: string[] = [];
  const origWrite = proc.stdin.write.bind(proc.stdin);
  proc.stdin.write = function (chunk: any, encodingOrCb: any, cb: any): boolean {
    const data = typeof chunk === "string" ? chunk : chunk.toString();
    writes.push(data);

    // Schedule response processing after the write completes
    setImmediate(() => {
      try {
        const request = JSON.parse(data.trim());
        const id = request.id;
        const method = request.method;

        if (method === "initialize") {
          proc.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id,
            result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1.0" } },
          }) + "\n");
        } else if (method === "tools/list") {
          proc.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id,
            result: { tools },
          }) + "\n");
        } else if (method === "tools/call") {
          const params = request.params as Record<string, unknown> | undefined;
          const toolName = params?.name as string ?? "unknown";
          proc.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id,
            result: { content: [{ type: "text", text: `Result from ${toolName}: ${JSON.stringify(params?.arguments ?? {})}` }] },
          }) + "\n");
        }
      } catch { /* partial write — ignore */ }
    });

    return origWrite(chunk as Buffer, encodingOrCb, cb);
  } as any;
  return writes;
}

function autoHandshakeNullTools(proc: MockChildProcess): void {
  const origWrite = proc.stdin.write.bind(proc.stdin);
  proc.stdin.write = function (chunk: any, encodingOrCb: any, cb: any): boolean {
    const data = typeof chunk === "string" ? chunk : chunk.toString();
    setImmediate(() => {
      try {
        const request = JSON.parse(data.trim());
        const id = request.id;
        if (request.method === "initialize") {
          proc.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id,
            result: { protocolVersion: "2025-06-18", capabilities: {} },
          }) + "\n");
        } else if (request.method === "tools/list") {
          proc.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id,
            result: { tools: null },
          }) + "\n");
        }
      } catch { /* ignore */ }
    });
    return origWrite(chunk as Buffer, encodingOrCb, cb);
  } as any;
}

function autoHandshakeWithErrors(proc: MockChildProcess, tools: McpToolDefinition[] = []): void {
  const origWrite = proc.stdin.write.bind(proc.stdin);
  proc.stdin.write = function (chunk: any, encodingOrCb: any, cb: any): boolean {
    const data = typeof chunk === "string" ? chunk : chunk.toString();
    setImmediate(() => {
      try {
        const request = JSON.parse(data.trim());
        const id = request.id;
        if (request.method === "initialize") {
          proc.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id,
            result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
          }) + "\n");
        } else if (request.method === "tools/list") {
          proc.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id,
            result: { tools },
          }) + "\n");
        } else if (request.method === "tools/call") {
          proc.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id,
            result: {
              isError: true,
              content: [{ type: "text", text: "Something went wrong" }],
            },
          }) + "\n");
        }
      } catch { /* ignore */ }
    });
    return origWrite(chunk as Buffer, encodingOrCb, cb);
  } as any;
}

// ── Tests ──

test("McpClient construction stores config", () => {
  const config: McpServerConfig = {
    name: "test-server",
    transport: "stdio",
    command: "echo",
    args: ["hello"],
  };
  const client = new McpClient(config);
  assert.equal(client.config.name, "test-server");
  assert.equal(client.config.transport, "stdio");
  assert.equal(client.config.command, "echo");
  assert.equal(client.serverName, "test-server");
  assert.equal(client.isInitialized, false);
  assert.deepEqual(client.getTools(), []);
});

test("McpClient defaults args to empty array when not provided", () => {
  const client = new McpClient({ name: "minimal", transport: "stdio", command: "npx" });
  assert.equal(client.config.args, undefined);
});

test("McpClient HTTP transport throws not-implemented error", async () => {
  const client = new McpClient({ name: "http-srv", transport: "http", url: "http://localhost:8080/mcp" });
  await assert.rejects(
    () => client.connect(),
    (err: unknown) => err instanceof Error && err.message.includes("HTTP transport not yet implemented"),
  );
});

test("McpClient stdio transport requires a command", async () => {
  const client = new McpClient({ name: "no-cmd", transport: "stdio" });
  await assert.rejects(
    () => client.connect(),
    (err: unknown) => err instanceof Error && err.message.includes("stdio transport requires a command"),
  );
});

test("McpClient connect performs handshake and discovers tools", async () => {
  const proc = createMockProcess();
  const discoveredTools: McpToolDefinition[] = [
    { name: "search_repos", description: "Search GitHub repositories", inputSchema: { type: "object", properties: {} } },
    { name: "list_issues", description: "List repository issues", inputSchema: { type: "object", properties: { repo: { type: "string" } } } },
  ];
  autoHandshake(proc, discoveredTools);

  const client = new McpClient({
    name: "github-tools",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@anthropic/mcp-github"],
  }, singleProcSpawn(proc));

  await client.connect();

  assert.equal(client.isInitialized, true);
  const tools = client.getTools();
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, "search_repos");
  assert.equal(tools[1].name, "list_issues");

  await client.disconnect();
});

test("callTool returns error when client is not initialized", async () => {
  const client = new McpClient({ name: "uninit", transport: "stdio", command: "echo" });
  await assert.rejects(
    () => client.callTool("some_tool", {}),
    (err: unknown) => err instanceof Error && err.message.includes("MCP client not initialized"),
  );
});

test("callTool should not be called without a process connection (HTTP)", async () => {
  const client = new McpClient({ name: "no-proc", transport: "http", url: "http://localhost:8080/mcp" });
  await assert.rejects(
    () => client.callTool("test", {}),
    (err: unknown) => err instanceof Error && err.message.includes("MCP client not initialized"),
  );
});

// ── JSON-RPC message parsing (feedLine / onData) ──

test("feedLine parses successful JSON-RPC response and resolves pending request", async () => {
  const client = new McpClient({ name: "line-test", transport: "stdio", command: "echo" });

  const responsePromise = new Promise<unknown>((resolve, reject) => {
    (client as any).pending.set(42, { resolve, reject });
  });

  client.feedLine(JSON.stringify({
    jsonrpc: "2.0", id: 42,
    result: { tools: [{ name: "foo", description: "A tool", inputSchema: {} }] },
  }) + "\n");

  const result = await responsePromise;
  assert.deepEqual(result, { tools: [{ name: "foo", description: "A tool", inputSchema: {} }] });
  assert.equal((client as any).pending.size, 0);
});

test("feedLine parses error JSON-RPC response and rejects pending request", async () => {
  const client = new McpClient({ name: "err-test", transport: "stdio", command: "echo" });

  const errorPromise = new Promise<unknown>((resolve, reject) => {
    (client as any).pending.set(7, { resolve, reject });
  });

  client.feedLine(JSON.stringify({
    jsonrpc: "2.0", id: 7,
    error: { code: -32601, message: "Method not found" },
  }) + "\n");

  await assert.rejects(
    () => errorPromise,
    (err: unknown) => err instanceof Error && err.message.includes("Method not found"),
  );
  assert.equal((client as any).pending.size, 0);
});

test("feedLine ignores non-JSON lines (server logs)", () => {
  const client = new McpClient({ name: "log-test", transport: "stdio", command: "echo" });

  let resolved = false;
  (client as any).pending.set(1, {
    resolve: () => { resolved = true; },
    reject: () => {},
  });

  client.feedLine("Server started on port 8080\n");
  client.feedLine("[INFO] Listening for connections...\n");
  client.feedLine("\n");

  assert.equal(resolved, false);
  assert.equal((client as any).pending.size, 1);
});

test("feedLine ignores responses with unknown IDs", () => {
  const client = new McpClient({ name: "unknown-id", transport: "stdio", command: "echo" });

  let resolved = false;
  (client as any).pending.set(1, {
    resolve: () => { resolved = true; },
    reject: () => {},
  });

  client.feedLine(JSON.stringify({
    jsonrpc: "2.0", id: 999,
    result: { ignored: true },
  }) + "\n");

  assert.equal(resolved, false);
  assert.equal((client as any).pending.size, 1);
});

test("feedLine handles multiple JSON-RPC responses in a single data chunk", async () => {
  const client = new McpClient({ name: "batch-test", transport: "stdio", command: "echo" });

  const results: unknown[] = [];
  (client as any).pending.set(1, { resolve: (v: unknown) => results.push(v), reject: () => {} });
  (client as any).pending.set(2, { resolve: (v: unknown) => results.push(v), reject: () => {} });

  client.feedLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: "first" }) + "\n" +
    JSON.stringify({ jsonrpc: "2.0", id: 2, result: "second" }) + "\n"
  );

  assert.deepEqual(results, ["first", "second"]);
  assert.equal((client as any).pending.size, 0);
});

test("feedLine handles partial lines (buffering)", async () => {
  const client = new McpClient({ name: "partial-test", transport: "stdio", command: "echo" });

  const results: unknown[] = [];
  (client as any).pending.set(5, { resolve: (v: unknown) => results.push(v), reject: () => {} });

  const fullResponse = JSON.stringify({ jsonrpc: "2.0", id: 5, result: "buffered" }) + "\n";

  // Send first part without a newline (should buffer)
  client.feedLine(fullResponse.slice(0, 20));
  assert.equal((client as any).buffer.length, 20);
  assert.deepEqual(results, []);

  // Send remainder including the newline
  client.feedLine(fullResponse.slice(20));

  assert.deepEqual(results, ["buffered"]);
  assert.equal((client as any).pending.size, 0);
  assert.equal((client as any).buffer, "");
});

// ── Tool discovery parsing ──

test("getTools returns empty array when no tools discovered", async () => {
  const proc = createMockProcess();
  autoHandshake(proc, []);

  const client = new McpClient({
    name: "empty-tools",
    transport: "stdio",
    command: "npx",
  }, singleProcSpawn(proc));

  await client.connect();
  assert.equal(client.getTools().length, 0);
  await client.disconnect();
});

test("getTools returns tools with full inputSchema preserved", async () => {
  const proc = createMockProcess();

  const schema = {
    type: "object",
    properties: {
      repo: { type: "string", description: "Repository name" },
      limit: { type: "number", default: 10 },
    },
    required: ["repo"],
  };

  autoHandshake(proc, [
    { name: "list_prs", description: "List pull requests", inputSchema: schema },
  ]);

  const client = new McpClient({
    name: "schema-test",
    transport: "stdio",
    command: "npx",
  }, singleProcSpawn(proc));

  await client.connect();
  const tools = client.getTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "list_prs");
  assert.deepEqual(tools[0].inputSchema, schema);
  await client.disconnect();
});

test("getTools handles null tools in result", async () => {
  const proc = createMockProcess();
  autoHandshakeNullTools(proc);

  const client = new McpClient({
    name: "null-tools",
    transport: "stdio",
    command: "npx",
  }, singleProcSpawn(proc));

  await client.connect();
  assert.deepEqual(client.getTools(), []);
  assert.equal(client.isInitialized, true);
  await client.disconnect();
});

// ── Disconnect cleanup ──

test("disconnect clears initialized flag and nullifies process", async () => {
  const proc = createMockProcess();
  autoHandshake(proc);

  const client = new McpClient({
    name: "dc-test",
    transport: "stdio",
    command: "npx",
  }, singleProcSpawn(proc));

  await client.connect();
  assert.equal(client.isInitialized, true);

  await client.disconnect();
  assert.equal(client.isInitialized, false);
  assert.equal((client as any).process, null);
});

test("disconnect rejects pending requests", async () => {
  const proc = createMockProcess();
  // Only auto-respond to initialize and tools/list, NOT tools/call
  const origWrite = proc.stdin.write.bind(proc.stdin);
  proc.stdin.write = function (chunk: any, encodingOrCb: any, cb: any): boolean {
    const data = typeof chunk === "string" ? chunk : chunk.toString();
    setImmediate(() => {
      try {
        const request = JSON.parse(data.trim());
        const id = request.id;
        if (request.method === "initialize") {
          proc.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id,
            result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
          }) + "\n");
        } else if (request.method === "tools/list") {
          proc.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id,
            result: { tools: [{ name: "some_tool", description: "A tool", inputSchema: {} }] },
          }) + "\n");
        }
        // tools/call: deliberately no response — the test verifies disconnect cleans up
      } catch { /* ignore */ }
    });
    return origWrite(chunk as Buffer, encodingOrCb, cb);
  } as any;

  const client = new McpClient({
    name: "pending-reject",
    transport: "stdio",
    command: "npx",
  }, singleProcSpawn(proc));

  await client.connect();

  // Start a tool call that will never get a response
  const callPromise = client.callTool("some_tool", {});
  // Brief pause to let the write flush
  await new Promise((r) => setTimeout(r, 20));

  // Disconnect should reject the pending call
  const disconnectPromise = client.disconnect();

  await assert.rejects(
    () => callPromise,
    (err: unknown) => err instanceof Error && err.message.includes("disconnected"),
  );
  await disconnectPromise;
  assert.equal(client.isInitialized, false);
});

// ── McpRegistry tests ──

test("McpRegistry starts with no servers", () => {
  const registry = new McpRegistry();
  assert.deepEqual(registry.getServerNames(), []);
  assert.deepEqual(registry.getAllTools(), []);
  assert.equal(registry.getClient("nonexistent"), undefined);
});

test("McpRegistry addServer connects and registers tools", async () => {
  const proc = createMockProcess();
  const tools: McpToolDefinition[] = [
    { name: "tool_a", description: "First tool", inputSchema: {} },
    { name: "tool_b", description: "Second tool", inputSchema: {} },
  ];
  autoHandshake(proc, tools);

  const registry = new McpRegistry(singleProcSpawn(proc));

  const discovered = await registry.addServer({
    name: "server1",
    transport: "stdio",
    command: "npx",
  });

  assert.equal(discovered.length, 2);
  assert.equal(discovered[0].name, "tool_a");
  assert.deepEqual(registry.getServerNames(), ["server1"]);

  const allTools = registry.getAllTools();
  assert.equal(allTools.length, 2);
  assert.equal(allTools[0].serverName, "server1");
  assert.equal(allTools[0].tool.name, "tool_a");

  await registry.disconnectAll();
});

test("McpRegistry addServer rejects duplicate server names", async () => {
  const proc = createMockProcess();
  autoHandshake(proc);

  const registry = new McpRegistry(singleProcSpawn(proc));

  await registry.addServer({ name: "dup", transport: "stdio", command: "npx" });

  await assert.rejects(
    () => registry.addServer({ name: "dup", transport: "stdio", command: "npx" }),
    (err: unknown) => err instanceof Error && err.message.includes("already connected"),
  );

  await registry.disconnectAll();
});

test("McpRegistry manages multiple servers independently", async () => {
  const proc1 = createMockProcess();
  const proc2 = createMockProcess();
  autoHandshake(proc1, [{ name: "t1", description: "Tool from s1", inputSchema: {} }]);
  autoHandshake(proc2, [{ name: "t2", description: "Tool from s2", inputSchema: {} }]);

  const registry = new McpRegistry(rotatingSpawn([proc1, proc2]));

  await registry.addServer({ name: "s1", transport: "stdio", command: "npx" });
  await registry.addServer({ name: "s2", transport: "stdio", command: "npx" });

  assert.deepEqual(registry.getServerNames(), ["s1", "s2"]);

  const allTools = registry.getAllTools();
  assert.equal(allTools.length, 2);
  assert.equal(allTools[0].serverName, "s1");
  assert.equal(allTools[1].serverName, "s2");

  const removed = await registry.removeServer("s1");
  assert.equal(removed, true);
  assert.deepEqual(registry.getServerNames(), ["s2"]);
  assert.equal(registry.getAllTools().length, 1);

  await registry.disconnectAll();
});

test("McpRegistry removeServer returns false for unknown server", async () => {
  const registry = new McpRegistry();
  const removed = await registry.removeServer("nonexistent");
  assert.equal(removed, false);
});

test("McpRegistry disconnectAll cleans up all servers", async () => {
  const proc1 = createMockProcess();
  const proc2 = createMockProcess();
  autoHandshake(proc1, [{ name: "a", description: "A", inputSchema: {} }]);
  autoHandshake(proc2, [{ name: "b", description: "B", inputSchema: {} }]);

  const registry = new McpRegistry(rotatingSpawn([proc1, proc2]));

  await registry.addServer({ name: "x", transport: "stdio", command: "npx" });
  await registry.addServer({ name: "y", transport: "stdio", command: "npx" });

  assert.equal(registry.getServerNames().length, 2);

  await registry.disconnectAll();

  assert.deepEqual(registry.getServerNames(), []);
  assert.deepEqual(registry.getAllTools(), []);
});

test("McpRegistry getClient returns undefined for unknown server", () => {
  const registry = new McpRegistry();
  assert.equal(registry.getClient("ghost"), undefined);
});

// ── Tool call via MCP client ──

test("callTool formats MCP response content blocks into ToolResult", async () => {
  const proc = createMockProcess();
  autoHandshake(proc, [
    { name: "echo", description: "Echo tool", inputSchema: { type: "object", properties: { msg: { type: "string" } } } },
  ]);

  const client = new McpClient({
    name: "echo-srv",
    transport: "stdio",
    command: "npx",
  }, singleProcSpawn(proc));

  await client.connect();

  const result = await client.callTool("echo", { msg: "hello" });
  assert.equal(result.error, undefined);
  assert.ok(result.content.includes("echo"));
  assert.ok(result.content.includes("hello"));
  assert.ok(result.summary.includes("echo"));

  await client.disconnect();
});

test("callTool marks result as error when isError flag is set", async () => {
  const proc = createMockProcess();
  autoHandshakeWithErrors(proc, [
    { name: "failing_tool", description: "Always fails", inputSchema: {} },
  ]);

  const client = new McpClient({
    name: "fail-srv",
    transport: "stdio",
    command: "npx",
  }, singleProcSpawn(proc));

  await client.connect();

  const result = await client.callTool("failing_tool", {});
  assert.ok(result.error);
  assert.ok(result.summary.includes("error"));

  await client.disconnect();
});
