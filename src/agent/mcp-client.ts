// MCP client for consuming external MCP servers
// Connects via stdio (subprocess) or streamable HTTP

import { spawn, type ChildProcess } from "node:child_process";
import type { ToolResult } from "./tools.js";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerConfig {
  name: string;           // Friendly name: "github-tools"
  transport: "stdio" | "http";
  command?: string;       // For stdio: "npx -y @anthropic/mcp-github"
  args?: string[];
  url?: string;           // For http: "http://localhost:8080/mcp"
  env?: Record<string, string>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// Simplified spawn signature for DI / testing
export type SpawnFactory = (command: string, args: string[], options: { env?: Record<string, string | undefined>; stdio: string[] }) => ChildProcess;

export class McpClient {
  readonly config: McpServerConfig;
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private buffer = "";
  private tools: McpToolDefinition[] = [];
  private initialized = false;
  private readonly _spawn: SpawnFactory;

  constructor(config: McpServerConfig, spawnFn?: SpawnFactory) {
    this.config = config;
    this._spawn = spawnFn ?? ((command, args, options) => spawn(command, args, options as any));
  }

  get serverName(): string {
    return this.config.name;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  async connect(): Promise<void> {
    if (this.config.transport === "stdio") {
      if (!this.config.command) throw new Error("stdio transport requires a command");
      this.process = this._spawn(this.config.command, this.config.args ?? [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...this.config.env },
      });
      this.process.stdout?.on("data", (data: Buffer) => this.onData(data.toString()));
      this.process.stderr?.on("data", (data: Buffer) => {
        // MCP servers may log to stderr — we capture but don't parse as JSON-RPC
      });
      this.process.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          // Server exited unexpectedly — reject all pending requests
          for (const [id, pending] of this.pending) {
            pending.reject(new Error(`MCP server "${this.config.name}" exited with code ${code}`));
            this.pending.delete(id);
          }
          this.initialized = false;
        }
      });
    } else {
      // HTTP transport — not implemented in this phase
      throw new Error("HTTP transport not yet implemented for MCP client consumption");
    }

    // Initialize MCP session
    await this.sendRequest("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      clientInfo: { name: "morpheos-code", version: "1.0.0" },
    });

    // Discover tools
    const result = await this.sendRequest("tools/list", {}) as { tools: McpToolDefinition[] };
    this.tools = result.tools ?? [];
    this.initialized = true;
  }

  getTools(): McpToolDefinition[] {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.initialized) throw new Error("MCP client not initialized");
    const raw = await this.sendRequest("tools/call", { name, arguments: args });
    // MCP tools/call returns content as an array of content blocks
    const result = raw as { content?: Array<{ type: string; text?: string; data?: string }> };
    const textParts: string[] = [];
    let hasError = false;
    let isError = false;
    if (result.content && Array.isArray(result.content)) {
      for (const block of result.content) {
        if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        } else if (block.type === "resource" && typeof block.text === "string") {
          textParts.push(block.text);
        } else {
          textParts.push(JSON.stringify(block));
        }
      }
    }
    // Check for isError flag
    const rawResult = raw as { isError?: boolean };
    if (rawResult.isError === true) {
      isError = true;
      hasError = true;
    }
    const content = textParts.join("\n") || JSON.stringify(raw);
    return {
      content,
      summary: isError ? `MCP tool "${name}" returned an error` : `MCP tool "${name}" completed`,
      error: isError ? content.slice(0, 200) : undefined,
    };
  }

  private async sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.process) throw new Error(`MCP client "${this.config.name}" is not connected`);
    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const line = JSON.stringify(request) + "\n";
      this.process?.stdin?.write(line);
    });
  }

  // Exposed for testing — feeds raw data into the JSON-RPC response buffer
  feedLine(data: string): void {
    this.onData(data);
  }

  private onData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const response = JSON.parse(line) as JsonRpcResponse;
        const pending = this.pending.get(response.id);
        if (!pending) continue;

        this.pending.delete(response.id);
        if (response.error) {
          pending.reject(new Error(`MCP error: ${response.error.message}`));
        } else {
          pending.resolve(response.result);
        }
      } catch {
        // Skip non-JSON lines (server logs)
      }
    }
  }

  async disconnect(): Promise<void> {
    // Reject all pending requests
    for (const [id, pending] of this.pending) {
      pending.reject(new Error(`MCP client "${this.config.name}" disconnected`));
      this.pending.delete(id);
    }
    this.process?.stdin?.end();
    this.process?.kill();
    this.process = null;
    this.initialized = false;
  }

  // For graceful shutdown — sends a shutdown notification before disconnect
  async shutdown(): Promise<void> {
    if (this.process && this.initialized) {
      try {
        // Send shutdown notification (no response expected per MCP spec)
        const request: JsonRpcRequest = { jsonrpc: "2.0", id: "shutdown", method: "shutdown", params: {} };
        this.process.stdin?.write(JSON.stringify(request) + "\n");
        // Give the server a moment to process
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        // Best-effort shutdown
      }
    }
    await this.disconnect();
  }
}

// Registry for managing multiple MCP connections
export class McpRegistry {
  private clients = new Map<string, McpClient>();
  private readonly _spawnFn?: SpawnFactory;

  constructor(spawnFn?: SpawnFactory) {
    this._spawnFn = spawnFn;
  }

  async addServer(config: McpServerConfig): Promise<McpToolDefinition[]> {
    if (this.clients.has(config.name)) {
      throw new Error(`MCP server "${config.name}" is already connected. Remove it first.`);
    }
    const client = new McpClient(config, this._spawnFn);
    await client.connect();
    this.clients.set(config.name, client);
    return client.getTools();
  }

  getClient(name: string): McpClient | undefined {
    return this.clients.get(name);
  }

  getAllTools(): Array<{ serverName: string; tool: McpToolDefinition }> {
    const result: Array<{ serverName: string; tool: McpToolDefinition }> = [];
    for (const [serverName, client] of this.clients) {
      for (const tool of client.getTools()) {
        result.push({ serverName, tool });
      }
    }
    return result;
  }

  getServerNames(): string[] {
    return Array.from(this.clients.keys());
  }

  async removeServer(name: string): Promise<boolean> {
    const client = this.clients.get(name);
    if (!client) return false;
    await client.shutdown();
    this.clients.delete(name);
    return true;
  }

  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.shutdown();
    }
    this.clients.clear();
  }
}
