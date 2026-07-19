// src/agent/tools.ts

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { exec } from "node:child_process";
import { HarnessError } from "../errors.js";

export interface ToolParam {
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
  required: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParam[];
}

export interface ToolResult {
  content: string;
  summary: string;
  error?: string;
}

export interface Tool {
  definition: ToolDefinition;
  tier: 1 | 2;
  execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult>;
}

export interface Tier2Gate {
  check(toolName: string, params: Record<string, unknown>): Promise<{ allowed: boolean; reason?: string }>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private tier2Gate: Tier2Gate | null = null;

  setTier2Gate(gate: Tier2Gate): void {
    this.tier2Gate = gate;
  }

  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
  }

  describe(): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    return Array.from(this.tools.values()).map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.definition.name,
        description: tool.definition.description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            tool.definition.parameters.map((p) => [p.name, { type: p.type, description: p.description }])
          ),
          required: tool.definition.parameters.filter((p) => p.required).map((p) => p.name),
        },
      },
    }));
  }

  toolDescriptions(): string {
    return Array.from(this.tools.values())
      .map((t) => `- **${t.definition.name}**: ${t.definition.description}`)
      .join("\n");
  }

  async execute(name: string, params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: "", summary: `Unknown tool: ${name}`, error: `Tool ${name} not found` };
    }

    if (tool.tier === 2) {
      if (!this.tier2Gate) {
        return {
          content: `Tool "${name}" requires authorisation. No authorisation gate has been configured.`,
          summary: `BLOCKED: ${name}`,
          error: "approval_required",
        };
      }
      const gate = await this.tier2Gate.check(name, params);
      if (!gate.allowed) {
        return {
          content: `Tool "${name}" requires authorisation. ${gate.reason ?? "Live operations have not been authorised for this session."}`,
          summary: `BLOCKED: ${name}`,
          error: gate.reason ?? "approval_required",
        };
      }
    }

    try {
      return await tool.execute(params, cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `Error executing ${name}: ${message}`, summary: `Error: ${name}`, error: message };
    }
  }
}

// ── Tier 1 Tools ──

function makeReadFileTool(): Tool {
  return {
    definition: {
      name: "read_file",
      description: "Read a file from the local filesystem. Returns content with line numbers (cat -n format).",
      parameters: [
        { name: "file_path", type: "string", description: "Absolute path to the file to read", required: true },
        { name: "offset", type: "number", description: "Line number to start reading from", required: false },
        { name: "limit", type: "number", description: "Number of lines to read", required: false },
      ],
    },
    tier: 1,
    async execute(params, _cwd): Promise<ToolResult> {
      const filePath = String(params.file_path);
      if (!path.isAbsolute(filePath)) {
        throw new HarnessError("invalid_path", `File path must be absolute: ${filePath}`);
      }
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n");
      const offset = typeof params.offset === "number" ? params.offset : 1;
      const limit = typeof params.limit === "number" ? params.limit : lines.length;
      const slice = lines.slice(Math.max(0, offset - 1), offset - 1 + limit);
      const numbered = slice.map((line, i) => `${String(offset + i).padStart(6)}\t${line}`).join("\n");
      return {
        content: numbered,
        summary: `Read ${slice.length} lines from ${path.basename(filePath)}`,
      };
    },
  };
}

function makeWriteFileTool(): Tool {
  return {
    definition: {
      name: "write_file",
      description: "Write or overwrite a file. Creates parent directories if needed.",
      parameters: [
        { name: "file_path", type: "string", description: "Absolute path to the file to write", required: true },
        { name: "content", type: "string", description: "Content to write", required: true },
      ],
    },
    tier: 1,
    async execute(params, _cwd): Promise<ToolResult> {
      const filePath = String(params.file_path);
      if (!path.isAbsolute(filePath)) {
        throw new HarnessError("invalid_path", `File path must be absolute: ${filePath}`);
      }
      const content = String(params.content);
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      const existed = fs.existsSync(filePath);
      fs.writeFileSync(filePath, content, "utf8");
      return {
        content: existed ? `Overwrote ${filePath}` : `Created ${filePath}`,
        summary: existed ? `Overwrote ${path.basename(filePath)}` : `Created ${path.basename(filePath)}`,
      };
    },
  };
}

function makeEditFileTool(): Tool {
  return {
    definition: {
      name: "edit_file",
      description: "Perform exact string replacement in a file. old_string must match exactly and be unique in the file.",
      parameters: [
        { name: "file_path", type: "string", description: "Absolute path to the file to edit", required: true },
        { name: "old_string", type: "string", description: "Exact text to replace", required: true },
        { name: "new_string", type: "string", description: "Text to replace with (must differ from old_string)", required: true },
      ],
    },
    tier: 1,
    async execute(params, _cwd): Promise<ToolResult> {
      const filePath = String(params.file_path);
      const oldStr = String(params.old_string);
      const newStr = String(params.new_string);
      if (!path.isAbsolute(filePath)) {
        throw new HarnessError("invalid_path", `File path must be absolute: ${filePath}`);
      }
      if (oldStr === newStr) {
        throw new HarnessError("invalid_edit", "old_string and new_string must be different");
      }
      const content = fs.readFileSync(filePath, "utf8");
      const firstIndex = content.indexOf(oldStr);
      if (firstIndex === -1) {
        throw new HarnessError("edit_string_not_found", "old_string was not found in the file");
      }
      if (content.indexOf(oldStr, firstIndex + 1) !== -1) {
        throw new HarnessError("edit_string_not_unique", "old_string matches multiple locations in the file");
      }
      const newContent = content.slice(0, firstIndex) + newStr + content.slice(firstIndex + oldStr.length);
      fs.writeFileSync(filePath, newContent, "utf8");
      return {
        content: `Edited ${filePath}: replaced ${oldStr.length} chars with ${newStr.length} chars`,
        summary: `Edited ${path.basename(filePath)}`,
      };
    },
  };
}

function makeSearchContentTool(): Tool {
  return {
    definition: {
      name: "search_content",
      description: "Search file contents using ripgrep or grep. Returns matching lines with file paths and line numbers.",
      parameters: [
        { name: "pattern", type: "string", description: "Pattern to search for (regex supported)", required: true },
        { name: "directory", type: "string", description: "Directory to search in (defaults to cwd)", required: false },
        { name: "file_pattern", type: "string", description: "Glob pattern to filter files (e.g. '*.ts')", required: false },
      ],
    },
    tier: 1,
    async execute(params, cwd): Promise<ToolResult> {
      const pattern = String(params.pattern);
      const directory = typeof params.directory === "string" ? String(params.directory) : cwd;
      const filePattern = typeof params.file_pattern === "string" ? String(params.file_pattern) : undefined;

      let stdout: string;
      try {
        const args = ["-n", "--no-heading", "-e", pattern];
        if (filePattern) args.push("--glob", filePattern);
        args.push(directory);
        stdout = execSync(`rg ${args.map(a => JSON.stringify(a)).join(" ")}`, {
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch {
        const grepArgs = ["-rn", "-E", pattern, directory];
        if (filePattern) grepArgs.push("--include", filePattern);
        stdout = execSync(`grep ${grepArgs.map(a => JSON.stringify(a)).join(" ")}`, {
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 10 * 1024 * 1024,
        });
      }

      const lines = stdout.trim().split("\n").filter(Boolean);
      return {
        content: lines.length > 0 ? lines.slice(0, 50).join("\n") + (lines.length > 50 ? `\n...and ${lines.length - 50} more matches` : "") : "No matches found.",
        summary: `${lines.length} matches for "${pattern}"`,
      };
    },
  };
}

function makeSearchFilesTool(): Tool {
  return {
    definition: {
      name: "search_files",
      description: "Search for files by name pattern using find.",
      parameters: [
        { name: "pattern", type: "string", description: "Filename pattern (glob, e.g. '*.ts')", required: true },
        { name: "directory", type: "string", description: "Directory to search in (defaults to cwd)", required: false },
      ],
    },
    tier: 1,
    async execute(params, cwd): Promise<ToolResult> {
      const pattern = String(params.pattern);
      const directory = typeof params.directory === "string" ? String(params.directory) : cwd;
      const stdout = execSync(`find ${JSON.stringify(directory)} -name ${JSON.stringify(pattern)} -not -path '*/node_modules/*' -not -path '*/.git/*'`, {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 5 * 1024 * 1024,
      });
      const files = stdout.trim().split("\n").filter(Boolean);
      return {
        content: files.length > 0 ? files.join("\n") : "No files found.",
        summary: `Found ${files.length} files matching "${pattern}"`,
      };
    },
  };
}

function makeRunCommandTool(): Tool {
  return {
    definition: {
      name: "run_command",
      description: "Execute a shell command. Has a timeout (default 120s, max 600s). Returns stdout and stderr.",
      parameters: [
        { name: "command", type: "string", description: "The command to execute", required: true },
        { name: "timeout_ms", type: "number", description: "Timeout in milliseconds (default 120000, max 600000)", required: false },
      ],
    },
    tier: 1,
    async execute(params, cwd): Promise<ToolResult> {
      const command = String(params.command);
      const timeoutMs = typeof params.timeout_ms === "number" ? Math.min(params.timeout_ms, 600_000) : 120_000;
      return new Promise((resolve) => {
        const child = exec(command, {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 20 * 1024 * 1024,
          encoding: "utf8",
        }, (error: any, stdout: string, stderr: string) => {
          const output = [stdout, stderr ? `\nSTDERR:\n${stderr}` : ""].filter(Boolean).join("\n").trim();
          resolve({
            content: output || "(no output)",
            summary: error ? `Command failed with exit code ${error.code}` : "Command completed",
            error: error?.message,
          });
        });
      });
    },
  };
}

function makeListDirectoryTool(): Tool {
  return {
    definition: {
      name: "list_directory",
      description: "List the contents of a directory.",
      parameters: [
        { name: "directory", type: "string", description: "Absolute path to the directory", required: true },
      ],
    },
    tier: 1,
    async execute(params, _cwd): Promise<ToolResult> {
      const dirPath = String(params.directory);
      if (!path.isAbsolute(dirPath)) {
        throw new HarnessError("invalid_path", `Directory path must be absolute: ${dirPath}`);
      }
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const listing = entries.map((e) => {
        const suffix = e.isDirectory() ? "/" : e.isSymbolicLink() ? "@" : "";
        return `${e.name}${suffix}`;
      }).join("\n");
      return {
        content: listing || "(empty directory)",
        summary: `${entries.length} items in ${path.basename(dirPath)}`,
      };
    },
  };
}

// ── Tier 2 Tool ──

function makeDeleteFileTool(): Tool {
  return {
    definition: {
      name: "delete_file",
      description: "Delete a file permanently. REQUIRES explicit user authorisation.",
      parameters: [
        { name: "file_path", type: "string", description: "Absolute path to the file to delete", required: true },
      ],
    },
    tier: 2,
    async execute(params, _cwd): Promise<ToolResult> {
      const filePath = String(params.file_path);
      if (!path.isAbsolute(filePath)) {
        throw new HarnessError("invalid_path", `File path must be absolute: ${filePath}`);
      }
      fs.unlinkSync(filePath);
      return {
        content: `Deleted ${filePath}`,
        summary: `Deleted ${path.basename(filePath)}`,
      };
    },
  };
}

// ── Factory ──

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(makeReadFileTool());
  registry.register(makeWriteFileTool());
  registry.register(makeEditFileTool());
  registry.register(makeSearchContentTool());
  registry.register(makeSearchFilesTool());
  registry.register(makeRunCommandTool());
  registry.register(makeListDirectoryTool());
  registry.register(makeDeleteFileTool());
  return registry;
}
