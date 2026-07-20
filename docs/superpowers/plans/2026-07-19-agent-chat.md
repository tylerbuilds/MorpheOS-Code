# Agent Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an interactive chat/REPL coding agent (`deepseek-harness chat`) as a new subsystem consuming the existing harness transport, store, approval, and cost layers.

**Architecture:** Seven new modules in `src/agent/` build on the proven harness foundation. The agent loop streams DeepSeek responses, executes tools with tiered safety (direct for reads/edits, approval-gated for destructive ops), manages context with a sliding window and Flash-based summarisation, and dispatches subagents for parallel work. The existing CLI gains one `"chat"` command — nothing else changes.

**Tech Stack:** TypeScript (Node 24+), Node test runner, existing DeepSeek Harness v0.1.0 foundations (SQLite via `node:sqlite`, Zod, `node:readline`)

---

### Task 1: Store migration — session and message tables

**Files:**
- Modify: `src/store.ts`

**Goal:** Add session and message tables to the existing SQLite store so the agent layer can persist chat history and session metadata. Follow existing `migrate()` patterns exactly.

- [ ] **Step 1: Add session and message schema constants**

Open `src/store.ts`. After line 8 (`export const STATE_SCHEMA_VERSION = 1;`), bump the version and add new interfaces:

```typescript
export const STATE_SCHEMA_VERSION = 2;

// ... existing types ...

export interface SessionRecord {
  id: string;
  created_at: string;
  updated_at: string;
  cwd: string;
  model: string;
  summary: string;
  message_count: number;
  total_tokens: number;
  total_cost_usd: number;
}

export interface MessageRecord {
  id: number;
  session_id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls_json: string | null;
  tool_call_id: string | null;
  token_count: number | null;
  created_at: string;
}
```

- [ ] **Step 2: Add CREATE TABLE statements to migrate()**

In the `migrate()` method, after the existing `CREATE TABLE IF NOT EXISTS budget_reservations` block and before `PRAGMA user_version`, add:

```typescript
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        cwd TEXT NOT NULL,
        model TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        message_count INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        total_cost_usd REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_calls_json TEXT,
        tool_call_id TEXT,
        token_count INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
```

- [ ] **Step 3: Add session CRUD methods to HarnessStore**

After the existing `event()` method (after line 433), add these methods:

```typescript
  createSession(id: string, cwd: string, model: string): SessionRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO sessions (id, created_at, updated_at, cwd, model) VALUES (?, ?, ?, ?, ?)"
      )
      .run(id, now, now, cwd, model);
    return this.getSession(id);
  }

  getSession(id: string): SessionRecord {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new HarnessError("session_not_found", `Session not found: ${id}`);
    }
    return {
      id: String(row.id),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      cwd: String(row.cwd),
      model: String(row.model),
      summary: String(row.summary ?? ""),
      message_count: Number(row.message_count ?? 0),
      total_tokens: Number(row.total_tokens ?? 0),
      total_cost_usd: Number(row.total_cost_usd ?? 0),
    };
  }

  listSessions(limit = 20): SessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      cwd: String(row.cwd),
      model: String(row.model),
      summary: String(row.summary ?? ""),
      message_count: Number(row.message_count ?? 0),
      total_tokens: Number(row.total_tokens ?? 0),
      total_cost_usd: Number(row.total_cost_usd ?? 0),
    }));
  }

  updateSession(id: string, updates: { summary?: string; message_count?: number; total_tokens?: number; total_cost_usd?: number }): void {
    const now = new Date().toISOString();
    const existing = this.getSession(id);
    const summary = updates.summary ?? existing.summary;
    const messageCount = updates.message_count ?? existing.message_count;
    const totalTokens = updates.total_tokens ?? existing.total_tokens;
    const totalCostUsd = updates.total_cost_usd ?? existing.total_cost_usd;
    this.db
      .prepare(
        "UPDATE sessions SET updated_at = ?, summary = ?, message_count = ?, total_tokens = ?, total_cost_usd = ? WHERE id = ?"
      )
      .run(now, summary, messageCount, totalTokens, totalCostUsd, id);
  }

  addMessage(sessionId: string, message: { role: string; content?: string | null; tool_calls_json?: string | null; tool_call_id?: string | null; token_count?: number | null }): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "INSERT INTO messages (session_id, role, content, tool_calls_json, tool_call_id, token_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        sessionId,
        message.role,
        message.content ?? null,
        message.tool_calls_json ?? null,
        message.tool_call_id ?? null,
        message.token_count ?? null,
        now
      );
    return Number(result.lastInsertRowid);
  }

  getMessages(sessionId: string, limit?: number, offset = 0): MessageRecord[] {
    const query = limit !== undefined
      ? "SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT ? OFFSET ?"
      : "SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC";
    const rows = limit !== undefined
      ? this.db.prepare(query).all(sessionId, limit, offset) as Record<string, unknown>[]
      : this.db.prepare(query).all(sessionId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id),
      session_id: String(row.session_id),
      role: String(row.role),
      content: row.content === null ? null : String(row.content),
      tool_calls_json: row.tool_calls_json === null ? null : String(row.tool_calls_json),
      tool_call_id: row.tool_call_id === null ? null : String(row.tool_call_id),
      token_count: row.token_count === null ? null : Number(row.token_count),
      created_at: String(row.created_at),
    }));
  }

  countMessages(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ?")
      .get(sessionId) as { cnt: number };
    return row.cnt;
  }

  deleteSession(sessionId: string): void {
    this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }
```

- [ ] **Step 4: Build and run existing tests to confirm no regression**

```bash
cd /Users/tyler/Code/control-plane/deepseek-harness-productise
npm run build
npm test
```

Expected: All existing tests pass (183 test/subtest results).

- [ ] **Step 5: Write tests for new store methods**

Create `test/agent-store.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessStore } from "../src/store.js";

function tempStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-agent-store-"));
}

test("createSession stores and retrieves session", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    const session = store.createSession("sess-1", "/home/user/project", "deepseek-v4-flash");
    assert.equal(session.id, "sess-1");
    assert.equal(session.cwd, "/home/user/project");
    assert.equal(session.model, "deepseek-v4-flash");
    assert.equal(session.message_count, 0);
    assert.equal(session.total_tokens, 0);
  } finally {
    store.close();
  }
});

test("getSession throws for missing session", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    assert.throws(() => store.getSession("nonexistent"), { code: "session_not_found" });
  } finally {
    store.close();
  }
});

test("listSessions returns sessions ordered by updated_at", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-a", "/a", "deepseek-v4-flash");
    store.createSession("sess-b", "/b", "deepseek-v4-pro");
    const sessions = store.listSessions();
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].id, "sess-b"); // most recent first
  } finally {
    store.close();
  }
});

test("addMessage and getMessages store and retrieve chat messages", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-1", "/project", "deepseek-v4-flash");
    store.addMessage("sess-1", { role: "user", content: "hello" });
    store.addMessage("sess-1", { role: "assistant", content: "hi there", token_count: 42 });
    store.addMessage("sess-1", { role: "tool", content: "result", tool_call_id: "call_1" });

    const messages = store.getMessages("sess-1");
    assert.equal(messages.length, 3);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[1].role, "assistant");
    assert.equal(messages[1].token_count, 42);
    assert.equal(messages[2].tool_call_id, "call_1");
  } finally {
    store.close();
  }
});

test("getMessages with limit and offset", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-1", "/p", "deepseek-v4-flash");
    store.addMessage("sess-1", { role: "user", content: "a" });
    store.addMessage("sess-1", { role: "assistant", content: "b" });
    store.addMessage("sess-1", { role: "user", content: "c" });
    store.addMessage("sess-1", { role: "assistant", content: "d" });

    const page = store.getMessages("sess-1", 2, 1);
    assert.equal(page.length, 2);
    assert.equal(page[0].content, "b");
    assert.equal(page[1].content, "c");
  } finally {
    store.close();
  }
});

test("updateSession modifies metadata", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-1", "/p", "deepseek-v4-flash");
    store.updateSession("sess-1", { summary: "fixed the auth bug", message_count: 12, total_tokens: 1500, total_cost_usd: 0.003 });
    const session = store.getSession("sess-1");
    assert.equal(session.summary, "fixed the auth bug");
    assert.equal(session.message_count, 12);
    assert.equal(session.total_tokens, 1500);
  } finally {
    store.close();
  }
});

test("deleteSession cascade-deletes messages", () => {
  const dir = tempStateDir();
  const store = new HarnessStore(dir);
  try {
    store.createSession("sess-1", "/p", "deepseek-v4-flash");
    store.addMessage("sess-1", { role: "user", content: "hello" });
    store.deleteSession("sess-1");
    assert.throws(() => store.getSession("sess-1"), { code: "session_not_found" });
    assert.equal(store.getMessages("sess-1").length, 0);
  } finally {
    store.close();
  }
});
```

- [ ] **Step 6: Run tests to verify new store methods**

```bash
cd /Users/tyler/Code/control-plane/deepseek-harness-productise
npm run build
node --test dist/test/agent-store.test.js
```

Expected: All tests pass.

- [ ] **Step 7: Run full test suite to confirm zero regressions**

```bash
npm test
```

Expected: 183 + new test results, all passing.

- [ ] **Step 8: Commit**

```bash
git add src/store.ts test/agent-store.test.ts
git commit -m "feat(store): add session and message tables for agent chat"
```

---

### Task 2: Agent prompts — system prompt templates

**Files:**
- Create: `src/agent/prompts.ts`

**Goal:** Define the base system prompt and subagent prompts. The base prompt describes available tools, safety boundaries, and the agent's role.

- [ ] **Step 1: Create the prompts module**

```typescript
// src/agent/prompts.ts

export function baseSystemPrompt(toolDescriptions: string): string {
  return `You are DeepSeek Harness Chat, an interactive coding agent running locally on the user's machine.

You have access to tools for reading, writing, searching, and executing code. Use them to help the user with software engineering tasks.

## Safety

- You may read, write, and edit files, run commands, and search the codebase.
- Destructive operations (deleting files, pushing to git, publishing packages) require explicit user authorisation.
- Never expose secrets, tokens, keys, credentials, or private records.
- Before deleting or overwriting files, confirm with the user unless they have explicitly authorised it.

## Working Style

- Be direct, practical, and evidence-driven.
- Prefer minimal, reversible changes.
- Verify commands and tool results before claiming success.
- Reference code as \`file_path:line_number\`.

## Available Tools

${toolDescriptions}

## Response Format

Respond with markdown where helpful. When you need to act, use tool calls. When you're done acting and have a result to report, respond without tool calls so the user can continue the conversation.`;
}

export function subagentSystemPrompt(
  task: string,
  context: string,
  availableTools: string
): string {
  return `You are a specialised subagent dispatched to complete a specific task. Work independently and return a structured result.

## Task

${task}

## Context

${context}

## Available Tools

${availableTools}

## Output Format

You MUST end your response with a status block:

\`\`\`status
status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
summary: <brief one-line summary of what was accomplished or why blocked>
\`\`\`

If DONE_WITH_CONCERNS, add a \`concerns:\` line listing specific worries.
If NEEDS_CONTEXT, add a \`context_needed:\` line describing what information you need.
If BLOCKED, add a \`blocker:\` line explaining the blocker.

Do not ask the orchestrating agent questions — use the status block instead.`;
}

export function specReviewPrompt(plan: string, implementation: string): string {
  return `You are a spec compliance reviewer. Compare the implementation against the spec and identify any gaps or extras.

## Spec

${plan}

## Implementation Summary

${implementation}

## Instructions

1. Check that every requirement in the spec is met by the implementation.
2. Check that the implementation does not add features not in the spec.
3. Report findings.

Output format:

\`\`\`review
status: APPROVED | CHANGES_REQUESTED
summary: <one-line summary>
issues:
  - type: missing | extra | wrong
    description: <what's wrong>
    spec_ref: <which spec section>
\`\`\`
`;
}

export function codeQualityPrompt(code: string, files: string[]): string {
  return `You are a code quality reviewer. Review the following implementation for correctness, style, and maintainability.

## Files Changed

${files.join("\n")}

## Code

${code}

## Instructions

1. Check for bugs, edge cases, and error handling gaps.
2. Check that the code follows the project's existing patterns and conventions.
3. Check for test coverage of the changes.
4. Report findings.

Output format:

\`\`\`review
status: APPROVED | CHANGES_REQUESTED
summary: <one-line summary>
strengths:
  - <what's good>
issues:
  - severity: important | minor
    file: <file path>
    description: <what's wrong>
    suggestion: <how to fix>
\`\`\`
`;
}
```

- [ ] **Step 2: Build and verify TypeScript compiles**

```bash
cd /Users/tyler/Code/control-plane/deepseek-harness-productise
npm run typecheck
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/agent/prompts.ts
git commit -m "feat(agent): add system prompt templates"
```

---

### Task 3: Tool registry — tiered execution

**Files:**
- Create: `src/agent/tools.ts`

**Goal:** Define the Tool interface, ToolRegistry class, and implement all Tier 1 tools. Tier 2 tools are defined but delegate to approval.ts for gating.

- [ ] **Step 1: Create the tools module**

```typescript
// src/agent/tools.ts

import fs from "node:fs";
import path from "node:path";
import { execSync, exec } from "node:child_process";
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

    if (tool.tier === 2 && this.tier2Gate) {
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
      description: "Write or overwrite a file. Creates parent directories if needed. Warns before overwriting existing files.",
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
      const directory = typeof params.file_path === "string" ? String(params.file_path) : cwd;
      const filePattern = typeof params.file_pattern === "string" ? String(params.file_pattern) : undefined;

      // Try ripgrep first, fall back to grep
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
        // rg not found, try grep
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
    async execute(params, _cwd): Promise<ToolResult> {
      const command = String(params.command);
      const timeoutMs = typeof params.timeout_ms === "number" ? Math.min(params.timeout_ms, 600_000) : 120_000;
      return new Promise((resolve) => {
        const child = exec(command, {
          cwd: _cwd,
          timeout: timeoutMs,
          maxBuffer: 20 * 1024 * 1024,
          encoding: "utf8",
        }, (error, stdout, stderr) => {
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

// ── Tier 2 Tools (definitions, gated in execute) ──

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
```

- [ ] **Step 2: Build and verify**

```bash
cd /Users/tyler/Code/control-plane/deepseek-harness-productise
npm run typecheck
```

Expected: No errors.

- [ ] **Step 3: Write tool registry tests**

Create `test/agent-tools.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createToolRegistry } from "../src/agent/tools.js";

const registry = createToolRegistry();

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-tools-"));
}

test("tool registry describes all tools as function definitions", () => {
  const described = registry.describe();
  assert.ok(described.length >= 7);
  for (const def of described) {
    assert.equal(def.type, "function");
    assert.ok(def.function.name.length > 0);
    assert.ok(def.function.description.length > 0);
  }
});

test("read_file returns numbered lines", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "test.txt");
  fs.writeFileSync(filePath, "line one\nline two\nline three\n", "utf8");
  const result = await registry.execute("read_file", { file_path: filePath }, dir);
  assert.ok(result.content.includes("     1\tline one"));
  assert.ok(result.content.includes("     2\tline two"));
  assert.ok(result.summary.includes("test.txt"));
});

test("read_file rejects relative paths", async () => {
  const result = await registry.execute("read_file", { file_path: "relative/path.txt" }, "/tmp");
  assert.ok(result.error);
});

test("write_file creates file and parent directories", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "nested", "subdir", "out.txt");
  const result = await registry.execute("write_file", { file_path: filePath, content: "hello world" }, dir);
  assert.ok(result.summary.includes("out.txt"));
  assert.equal(fs.readFileSync(filePath, "utf8"), "hello world");
});

test("edit_file replaces exact string", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "edit.txt");
  fs.writeFileSync(filePath, "const x = 1;\nconst y = 2;\n", "utf8");
  const result = await registry.execute("edit_file", {
    file_path: filePath,
    old_string: "const x = 1;",
    new_string: "const x = 42;",
  }, dir);
  assert.ok(result.summary.includes("edit.txt"));
  assert.ok(fs.readFileSync(filePath, "utf8").includes("const x = 42;"));
});

test("edit_file fails when old_string is not unique", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "dup.txt");
  fs.writeFileSync(filePath, "foo\nfoo\n", "utf8");
  const result = await registry.execute("edit_file", {
    file_path: filePath,
    old_string: "foo",
    new_string: "bar",
  }, dir);
  assert.ok(result.error);
});

test("search_content finds matches", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "a.ts"), "const API_KEY = 'secret';", "utf8");
  fs.writeFileSync(path.join(dir, "b.ts"), "const apiKey = process.env.KEY;", "utf8");
  const result = await registry.execute("search_content", { pattern: "KEY", directory: dir }, dir);
  assert.ok(result.summary.includes("matches"));
});

test("list_directory returns entries", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "", "utf8");
  fs.mkdirSync(path.join(dir, "subdir"));
  const result = await registry.execute("list_directory", { directory: dir }, dir);
  assert.ok(result.content.includes("a.txt"));
  assert.ok(result.content.includes("subdir/"));
});

test("unknown tool returns error", async () => {
  const result = await registry.execute("nonexistent_tool", {}, "/tmp");
  assert.ok(result.error);
});

test("tier 1 tools execute without gate", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "test.txt"), "hello", "utf8");
  const result = await registry.execute("read_file", { file_path: path.join(dir, "test.txt") }, dir);
  assert.equal(result.error, undefined);
});

test("tier 2 tools blocked without gate authorisation", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "target.txt");
  fs.writeFileSync(filePath, "delete me", "utf8");
  const result = await registry.execute("delete_file", { file_path: filePath }, dir);
  assert.ok(result.error);
  assert.ok(result.error.includes("approval_required"));
  assert.ok(fs.existsSync(filePath)); // file still exists
});
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/tyler/Code/control-plane/deepseek-harness-productise
npm run build
node --test dist/test/agent-tools.test.js
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools.ts test/agent-tools.test.ts
git commit -m "feat(agent): add tool registry with tiered execution"
```

---

### Task 4: Agent session management

**Files:**
- Create: `src/agent/session.ts`

**Goal:** Thin wrappers over HarnessStore session methods. Handles session creation, resumption, listing, and context message loading.

- [ ] **Step 1: Create session module**

```typescript
// src/agent/session.ts

import { randomUUID } from "node:crypto";
import { HarnessStore, type MessageRecord, type SessionRecord } from "../store.js";

export interface AgentSession {
  id: string;
  cwd: string;
  model: string;
  store: HarnessStore;
  record: SessionRecord;
}

export function createSession(store: HarnessStore, cwd: string, model = "deepseek-v4-flash"): AgentSession {
  const id = `sess_${randomUUID().split("-").join("_").slice(0, 20)}`;
  const record = store.createSession(id, cwd, model);
  return { id, cwd, model, store, record };
}

export function resumeSession(store: HarnessStore, sessionId: string): AgentSession {
  const record = store.getSession(sessionId);
  return {
    id: record.id,
    cwd: record.cwd,
    model: record.model,
    store,
    record,
  };
}

export function listSessions(store: HarnessStore, limit = 20): SessionRecord[] {
  return store.listSessions(limit);
}

export function addUserMessage(session: AgentSession, content: string): number {
  const id = session.store.addMessage(session.id, { role: "user", content });
  session.store.updateSession(session.id, {
    message_count: session.store.countMessages(session.id),
  });
  return id;
}

export function addAssistantMessage(session: AgentSession, content: string | null, toolCalls: unknown[] | null, tokenCount: number | null): number {
  const id = session.store.addMessage(session.id, {
    role: "assistant",
    content,
    tool_calls_json: toolCalls ? JSON.stringify(toolCalls) : null,
    token_count: tokenCount,
  });
  session.store.updateSession(session.id, {
    message_count: session.store.countMessages(session.id),
    total_tokens: session.record.total_tokens + (tokenCount ?? 0),
  });
  return id;
}

export function addToolResult(session: AgentSession, toolCallId: string, content: string): number {
  return session.store.addMessage(session.id, {
    role: "tool",
    content,
    tool_call_id: toolCallId,
  });
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export function loadMessages(session: AgentSession, limit?: number, offset?: number): ChatMessage[] {
  const records = session.store.getMessages(session.id, limit, offset);
  return records.map(toChatMessage);
}

function toChatMessage(record: MessageRecord): ChatMessage {
  const msg: ChatMessage = {
    role: record.role as ChatMessage["role"],
    content: record.content,
  };
  if (record.tool_calls_json) {
    msg.tool_calls = JSON.parse(record.tool_calls_json);
  }
  if (record.tool_call_id) {
    msg.tool_call_id = record.tool_call_id;
  }
  return msg;
}

export function updateSessionSummary(session: AgentSession, summary: string): void {
  session.store.updateSession(session.id, { summary });
}

export function updateSessionCost(session: AgentSession, additionalCostUsd: number): void {
  session.store.updateSession(session.id, {
    total_cost_usd: session.record.total_cost_usd + additionalCostUsd,
  });
}
```

- [ ] **Step 2: Build and verify**

```bash
cd /Users/tyler/Code/control-plane/deepseek-harness-productise
npm run typecheck
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/agent/session.ts
git commit -m "feat(agent): add session management layer"
```

---

### Task 5: Context management

**Files:**
- Create: `src/agent/context.ts`

**Goal:** Build the context window for each turn: system prompt, pinned project files, recent messages, and summarised history.

- [ ] **Step 1: Create context module**

```typescript
// src/agent/context.ts

import fs from "node:fs";
import path from "node:path";
import { baseSystemPrompt } from "./prompts.js";
import type { AgentSession, ChatMessage } from "./session.js";
import { loadMessages } from "./session.js";
import { createToolRegistry } from "./tools.js";

const MAX_RECENT_MESSAGES = 25;
const SUMMARY_TRIGGER_TOKENS = 90_000; // 75% of 128K context window
const PINNED_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "COPILOT.md"];

export interface ContextPackage {
  messages: ChatMessage[];
  estimatedTokens: number;
  summarised: boolean;
}

export function buildContext(session: AgentSession, userInput?: string): ContextPackage {
  const messages: ChatMessage[] = [];

  // 1. System prompt
  const registry = createToolRegistry();
  messages.push({
    role: "system",
    content: baseSystemPrompt(registry.toolDescriptions()),
  });

  // 2. Pinned project context
  const pinned = readPinnedFiles(session.cwd);
  if (pinned) {
    messages.push({
      role: "system",
      content: `Project context:\n\n${pinned}`,
    });
  }

  // 3. Message history
  const allMessages = loadMessages(session);
  const totalMessages = allMessages.length;

  if (totalMessages <= MAX_RECENT_MESSAGES) {
    // All messages fit
    for (const msg of allMessages) {
      messages.push(msg);
    }
  } else {
    // Summarise older messages
    const recent = allMessages.slice(-MAX_RECENT_MESSAGES);
    const olderCount = totalMessages - MAX_RECENT_MESSAGES;
    messages.push({
      role: "system",
      content: `[${olderCount} earlier messages have been summarised for context. The most recent ${MAX_RECENT_MESSAGES} messages follow.]`,
    });
    for (const msg of recent) {
      messages.push(msg);
    }
  }

  // 4. Current user input (if any)
  if (userInput) {
    messages.push({ role: "user", content: userInput });
  }

  // 5. Estimate tokens (rough: 1 token ≈ 4 chars)
  const charCount = messages.reduce((sum, m) => {
    let chars = (m.content ?? "").length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    return sum + chars;
  }, 0);
  const estimatedTokens = Math.ceil(charCount / 4);

  return {
    messages,
    estimatedTokens,
    summarised: totalMessages > MAX_RECENT_MESSAGES,
  };
}

function readPinnedFiles(cwd: string): string | null {
  const parts: string[] = [];
  for (const filename of PINNED_FILES) {
    const filePath = path.join(cwd, filename);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      parts.push(`### ${filename}\n\n${content}`);
    } catch {
      // File doesn't exist, skip
    }
  }
  if (parts.length === 0) return null;
  return parts.join("\n\n---\n\n");
}

export function shouldSummarise(estimatedTokens: number): boolean {
  return estimatedTokens > SUMMARY_TRIGGER_TOKENS;
}

export function contextSummary(context: ContextPackage): string {
  return `Context: ${context.messages.length} messages, ~${context.estimatedTokens} tokens${context.summarised ? " (summarised)" : ""}`;
}
```

- [ ] **Step 2: Build and verify**

```bash
cd /Users/tyler/Code/control-plane/deepseek-harness-productise
npm run typecheck
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/agent/context.ts
git commit -m "feat(agent): add context management with sliding window"
```

---

### Task 6: DeepSeek streaming client

**Files:**
- Create: `src/agent/stream.ts`

**Goal:** Streaming chat completions client for the DeepSeek API. Separate from the existing batch `transport.ts` because the agent needs streaming, tool-calling, and a different response handling pattern.

- [ ] **Step 1: Create streaming client**

```typescript
// src/agent/stream.ts

import { HarnessError } from "../errors.js";
import type { ChatMessage } from "./session.js";

export interface StreamToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface StreamChunk {
  type: "text";
  content: string;
}

export interface StreamResponse {
  text: string;
  toolCalls: StreamToolCall[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
}

export class DeepSeekStreamClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;

  constructor(apiKey: string, baseUrl = "https://api.deepseek.com", timeoutMs = 120_000) {
    if (!apiKey?.trim()) {
      throw new HarnessError(
        "deepseek_api_key_not_present",
        "DEEPSEEK_API_KEY environment variable is not set. Set it to use live DeepSeek features.",
        {},
        3
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  async *streamChat(
    messages: ChatMessage[],
    options: {
      model?: string;
      tools?: Array<Record<string, unknown>>;
      temperature?: number;
      maxTokens?: number;
      onChunk?: (chunk: StreamChunk) => void;
    } = {}
  ): AsyncGenerator<StreamChunk, StreamResponse> {
    const model = options.model ?? "deepseek-v4-flash";
    const requestBody: Record<string, unknown> = {
      model,
      messages: messages.map((m) => {
        const msg: Record<string, unknown> = { role: m.role };
        if (m.content !== null) msg.content = m.content;
        if (m.tool_calls) msg.tool_calls = m.tool_calls;
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        return msg;
      }),
      stream: true,
    };

    if (options.tools?.length) {
      requestBody.tools = options.tools;
    }
    if (options.temperature !== undefined) {
      requestBody.temperature = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      requestBody.max_tokens = options.maxTokens;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok || !response.body) {
      const raw = await response.json().catch(() => null) as Record<string, unknown> | null;
      throw new HarnessError("deepseek_api_error", "DeepSeek streaming request failed", {
        http_status: response.status,
        provider_error: raw?.error ?? null,
      });
    }

    let fullText = "";
    const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
    let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") break;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;

            // Text content
            if (delta.content) {
              fullText += delta.content;
              const chunk: StreamChunk = { type: "text", content: delta.content };
              options.onChunk?.(chunk);
              yield chunk;
            }

            // Tool calls
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index as number;
                if (!toolCallMap.has(idx)) {
                  toolCallMap.set(idx, { id: tc.id ?? "", name: "", args: "" });
                }
                const entry = toolCallMap.get(idx)!;
                if (tc.id) entry.id = tc.id;
                if (tc.function?.name) entry.name += tc.function.name;
                if (tc.function?.arguments) entry.args += tc.function.arguments;
              }
            }

            // Usage (final chunk)
            if (parsed.usage) {
              usage = {
                prompt_tokens: parsed.usage.prompt_tokens ?? 0,
                completion_tokens: parsed.usage.completion_tokens ?? 0,
                total_tokens: parsed.usage.total_tokens ?? 0,
              };
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls: StreamToolCall[] = Array.from(toolCallMap.values()).map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: tc.args,
      },
    }));

    return {
      text: fullText,
      toolCalls,
      usage,
    };
  }
}

export function getApiKey(): string {
  return process.env.DEEPSEEK_API_KEY ?? "";
}

export function createStreamClient(timeoutMs?: number): DeepSeekStreamClient {
  return new DeepSeekStreamClient(getApiKey(), undefined, timeoutMs);
}
```

- [ ] **Step 2: Build and verify**

```bash
cd /Users/tyler/Code/control-plane/deepseek-harness-productise
npm run typecheck
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/agent/stream.ts
git commit -m "feat(agent): add DeepSeek streaming chat client"
```


---

### Task 7: Agent loop — core think→act→observe cycle

**Files:**
- Create: `src/agent/loop.ts`

**Goal:** The main agent loop. Takes user input, streams to DeepSeek, executes tool calls, and iterates until the model responds with text only (no more tool calls). Uses `stream.ts` for API calls, `tools.ts` for tool execution, `session.ts` for state, and `context.ts` for context assembly.

- [ ] **Step 1: Create agent loop module**

```typescript
// src/agent/loop.ts

import { buildContext, contextSummary } from "./context.js";
import type { AgentSession, ChatMessage } from "./session.js";
import {
  addAssistantMessage,
  addToolResult,
  addUserMessage,
  updateSessionCost,
} from "./session.js";
import { consumeStream, type StreamResponse } from "./stream.js";
import { createToolRegistry, type ToolRegistry } from "./tools.js";

export interface AgentCallbacks {
  onText: (text: string) => void;
  onToolStart: (name: string, params: Record<string, unknown>) => void;
  onToolEnd: (name: string, summary: string, error?: string) => void;
  onTurnEnd: (text: string, toolCalls: number, tokens: number) => void;
}

function selectModel(sessionModel: string): string {
  return sessionModel; // For now, use session's model. Heuristics can be added later.
}

function estimateCost(model: string, tokens: number): number {
  // Rough estimates: Flash ~$0.27/M input, $1.10/M output; Pro ~$1.25/M input, $5.00/M output
  // Conservative: use output pricing since that's typically the larger cost
  const ratePerMillion = model === "deepseek-v4-pro" ? 5.0 : 1.10;
  return (tokens / 1_000_000) * ratePerMillion;
}

export async function agentTurn(
  session: AgentSession,
  apiKey: string,
  userInput: string,
  callbacks: AgentCallbacks,
  registry: ToolRegistry = createToolRegistry()
): Promise<void> {
  // 1. Store user message
  addUserMessage(session, userInput);

  // 2. Build context
  const ctx = buildContext(session);

  // 3. Select model
  const model = selectModel(session.model);

  // 4. Agent loop — keep going until model responds without tool calls
  let turnText = "";
  let toolCallCount = 0;
  let totalTokens = 0;
  let keepLooping = true;

  while (keepLooping) {
    const result = await consumeStream(
      apiKey,
      ctx.messages,
      registry.describe(),
      model,
      {
        onText: (text) => {
          turnText += text;
          callbacks.onText(text);
        },
      }
    );

    totalTokens += result.usage?.total_tokens ?? 0;

    // No tool calls? Turn is done.
    if (result.toolCalls.length === 0) {
      keepLooping = false;
      // Store final assistant message (text only)
      const assistantMsg: ChatMessage = { role: "assistant", content: result.text || null };
      ctx.messages.push(assistantMsg);
      addAssistantMessage(session, result.text || null, null, result.usage?.total_tokens ?? null);
      break;
    }

    // Execute each tool call
    for (const tc of result.toolCalls) {
      let params: Record<string, unknown> = {};
      try {
        params = JSON.parse(tc.function.arguments);
      } catch {
        // Invalid JSON — pass empty params
      }

      callbacks.onToolStart(tc.function.name, params);
      const execResult = await registry.execute(tc.function.name, params, session.cwd);
      callbacks.onToolEnd(tc.function.name, execResult.summary, execResult.error);

      toolCallCount++;

      // Add tool result to context
      ctx.messages.push({
        role: "tool",
        content: execResult.content,
        tool_call_id: tc.id,
      });

      // Persist tool result
      addToolResult(session, tc.id, execResult.content);
    }

    // Store assistant message with its tool calls
    const toolCallsForStore = result.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: tc.function,
    }));
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: result.text || null,
      tool_calls: toolCallsForStore as any,
    };
    ctx.messages.push(assistantMsg);
    addAssistantMessage(session, result.text || null, toolCallsForStore, result.usage?.total_tokens ?? null);
  }

  // 5. Update session cost
  updateSessionCost(session, estimateCost(model, totalTokens));
  callbacks.onTurnEnd(turnText, toolCallCount, totalTokens);
}
```

- [ ] **Step 2: Update stream.ts to export consumeStream**

Open `src/agent/stream.ts` and add the `consumeStream` function at the end. This is the non-generator wrapper that processes SSE events and returns the final `StreamResponse`:

```typescript
// Add to src/agent/stream.ts (after the DeepSeekStreamClient class)

export interface StreamResponse {
  text: string;
  toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

export async function consumeStream(
  apiKey: string,
  messages: Array<{ role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string }>,
  tools: Array<Record<string, unknown>>,
  model: string,
  callbacks: { onText: (text: string) => void },
  baseUrl = "https://api.deepseek.com",
  timeoutMs = 120_000,
): Promise<StreamResponse> {
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) => {
      const msg: Record<string, unknown> = { role: m.role };
      if (m.content !== null) msg.content = m.content;
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      return msg;
    }),
    stream: true,
  };
  if (tools.length > 0) body.tools = tools;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok || !response.body) {
    const raw = await response.json().catch(() => null) as Record<string, unknown> | null;
    throw new (await import("../errors.js")).HarnessError(
      "deepseek_api_error",
      `DeepSeek API request failed (HTTP ${response.status})`,
      { http_status: response.status, provider_error: raw?.error ?? null }
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
  let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) {
            fullText += delta.content;
            callbacks.onText(delta.content);
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index as number;
              if (!toolCallMap.has(idx)) {
                toolCallMap.set(idx, { id: tc.id ?? "", name: "", args: "" });
              }
              const entry = toolCallMap.get(idx)!;
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name += tc.function.name;
              if (tc.function?.arguments) entry.args += tc.function.arguments;
            }
          }
          if (parsed.usage) {
            usage = {
              prompt_tokens: Number(parsed.usage.prompt_tokens ?? 0),
              completion_tokens: Number(parsed.usage.completion_tokens ?? 0),
              total_tokens: Number(parsed.usage.total_tokens ?? 0),
            };
          }
        } catch {
          // Skip malformed SSE
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const toolCalls = Array.from(toolCallMap.values()).map((tc) => ({
    id: tc.id,
    type: "function" as const,
    function: { name: tc.name, arguments: tc.args },
  }));

  return { text: fullText, toolCalls, usage };
}
```

Also remove the `DeepSeekStreamClient` class and its async generator from stream.ts — the `consumeStream` function is the simpler and correct approach. Keep the `getApiKey()` helper:

```typescript
export function getApiKey(): string {
  return process.env.DEEPSEEK_API_KEY ?? "";
}
```

- [ ] **Step 3: Build and verify**

```bash
cd /Users/tyler/Code/control-plane/deepseek-harness-productise
npm run typecheck
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/agent/stream.ts src/agent/loop.ts
git commit -m "feat(agent): add core agent loop with streaming and tool execution"
```

---

### Task 8: Subagent dispatch

**Files:**
- Create: `src/agent/dispatch.ts`

**Goal:** Spawn isolated subagents as fresh DeepSeek API calls with curated context. Supports implementer, spec reviewer, and code quality reviewer roles.

- [ ] **Step 1: Create dispatch module**

```typescript
// src/agent/dispatch.ts

import { subagentSystemPrompt, specReviewPrompt, codeQualityPrompt } from "./prompts.js";
import { consumeStream, type StreamResponse, getApiKey } from "./stream.js";
import { createToolRegistry } from "./tools.js";

export type SubagentStatus = "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED";

export interface SubagentResult {
  status: SubagentStatus;
  summary: string;
  concerns?: string;
  contextNeeded?: string;
  blocker?: string;
  output: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

export interface DispatchParams {
  task: string;
  context?: string;
  model?: string;
  tools?: string[]; // Tool allow-list, defaults to read-only
}

function parseStatusBlock(text: string): {
  status: SubagentStatus;
  summary: string;
  concerns?: string;
  contextNeeded?: string;
  blocker?: string;
} {
  const match = text.match(/```status\n([\s\S]*?)\n```/);
  if (!match) {
    return { status: "DONE", summary: text.slice(0, 200) };
  }
  const block = match[1];
  const lines = block.split("\n").map((l) => l.trim());
  const status = (lines.find((l) => l.startsWith("status:"))?.split(":")[1]?.trim() ?? "DONE") as SubagentStatus;
  const summary = lines.find((l) => l.startsWith("summary:"))?.split(":").slice(1).join(":").trim() ?? "";
  const concerns = lines.find((l) => l.startsWith("concerns:"))?.split(":").slice(1).join(":").trim();
  const contextNeeded = lines.find((l) => l.startsWith("context_needed:"))?.split(":").slice(1).join(":").trim();
  const blocker = lines.find((l) => l.startsWith("blocker:"))?.split(":").slice(1).join(":").trim();
  return { status, summary, concerns, contextNeeded, blocker };
}

export async function dispatchSubagent(params: DispatchParams): Promise<SubagentResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      status: "BLOCKED",
      summary: "No DeepSeek API key configured",
      blocker: "DEEPSEEK_API_KEY not set",
      output: "",
      usage: null,
    };
  }

  const registry = createToolRegistry();
  const toolDefs = registry.describe();
  const toolDesc = registry.toolDescriptions();
  const model = params.model ?? "deepseek-v4-flash";

  const systemPrompt = subagentSystemPrompt(
    params.task,
    params.context ?? "No additional context provided.",
    toolDesc
  );

  const messages = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: `Complete the task described in the system prompt.` },
  ];

  let fullOutput = "";
  const result = await consumeStream(apiKey, messages, toolDefs, model, {
    onText: (text) => { fullOutput += text; },
  });

  const parsed = parseStatusBlock(fullOutput);

  return {
    status: parsed.status,
    summary: parsed.summary,
    concerns: parsed.concerns,
    contextNeeded: parsed.contextNeeded,
    blocker: parsed.blocker,
    output: fullOutput,
    usage: result.usage,
  };
}

export async function dispatchSpecReview(plan: string, implementation: string): Promise<SubagentResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      status: "BLOCKED",
      summary: "No DeepSeek API key configured",
      blocker: "DEEPSEEK_API_KEY not set",
      output: "",
      usage: null,
    };
  }

  const prompt = specReviewPrompt(plan, implementation);
  const messages = [
    { role: "system" as const, content: prompt },
    { role: "user" as const, content: "Review the implementation against the spec." },
  ];

  let fullOutput = "";
  const result = await consumeStream(apiKey, messages, [], "deepseek-v4-pro", {
    onText: (text) => { fullOutput += text; },
  });

  const parsed = parseStatusBlock(fullOutput);
  return {
    status: parsed.status,
    summary: parsed.summary,
    concerns: parsed.concerns,
    output: fullOutput,
    usage: result.usage,
  };
}

export async function dispatchCodeQualityReview(code: string, files: string[]): Promise<SubagentResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      status: "BLOCKED",
      summary: "No DeepSeek API key configured",
      blocker: "DEEPSEEK_API_KEY not set",
      output: "",
      usage: null,
    };
  }

  const prompt = codeQualityPrompt(code, files);
  const messages = [
    { role: "system" as const, content: prompt },
    { role: "user" as const, content: "Review the code for quality issues." },
  ];

  let fullOutput = "";
  const result = await consumeStream(apiKey, messages, [], "deepseek-v4-pro", {
    onText: (text) => { fullOutput += text; },
  });

  const parsed = parseStatusBlock(fullOutput);
  return {
    status: parsed.status,
    summary: parsed.summary,
    output: fullOutput,
    usage: result.usage,
  };
}
```

- [ ] **Step 2: Build and verify**

```bash
cd /Users/tyler/Code/control-plane/deepseek-harness-productise
npm run typecheck
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/agent/dispatch.ts
git commit -m "feat(agent): add subagent dispatch for parallel task execution"
```

---

### Task 9: Chat REPL CLI

**Files:**
- Create: `src/agent/cli.ts`

**Goal:** The interactive readline interface. Handles user input, renders streaming output, shows tool execution status, and manages slash commands (`/exit`, `/help`, `/model`, `/cost`, `/resume`, `/list`).

- [ ] **Step 1: Create chat REPL**

```typescript
// src/agent/cli.ts

import * as readline from "node:readline";
import { HarnessStore } from "../store.js";
import { agentTurn, type AgentCallbacks } from "./loop.js";
import {
  createSession,
  listSessions,
  resumeSession,
  updateSessionSummary,
  type AgentSession,
} from "./session.js";
import { getApiKey } from "./stream.js";

const STATE_DIR = process.env.DEEPSEEK_HARNESS_STATE_DIR ?? ".state";

function printDivider(): void {
  process.stdout.write("\n─".repeat(process.stdout.columns || 60) + "\n");
}

export interface ChatOptions {
  sessionId?: string;
  model?: string;
  list?: boolean;
  prompt?: string; // One-shot mode
}

export async function chatCommand(options: ChatOptions): Promise<void> {
  const store = new HarnessStore(STATE_DIR);

  try {
    // --list
    if (options.list) {
      const sessions = listSessions(store, 20);
      if (sessions.length === 0) {
        process.stdout.write("No sessions found.\n");
      } else {
        for (const s of sessions) {
          process.stdout.write(`${s.id}  ${s.updated_at.slice(0, 19)}  ${s.model.padEnd(18)}  $${s.total_cost_usd.toFixed(4)}  ${s.summary || "(no summary)"}\n`);
        }
      }
      return;
    }

    // Create or resume session
    let session: AgentSession;
    if (options.sessionId) {
      session = resumeSession(store, options.sessionId);
      process.stdout.write(`Resumed session: ${session.id}\n`);
      process.stdout.write(`Model: ${session.model}  CWD: ${session.cwd}  Cost so far: $${session.record.total_cost_usd.toFixed(4)}\n`);
    } else {
      const cwd = process.cwd();
      const model = options.model ?? "deepseek-v4-flash";
      session = createSession(store, cwd, model);
      process.stdout.write(`DeepSeek Harness Chat v0.1.0\n`);
      process.stdout.write(`Session: ${session.id}\n`);
      process.stdout.write(`Model: ${model}  CWD: ${cwd}\n`);
      process.stdout.write(`Type /help for commands, /exit to quit.\n`);
    }

    // One-shot mode
    if (options.prompt) {
      await runTurn(session, options.prompt, store);
      store.close();
      return;
    }

    // Interactive REPL
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "\n> ",
      terminal: true,
    });

    process.stdout.write("\n");
    rl.prompt();

    for await (const line of rl) {
      const input = line.trim();
      if (!input) {
        rl.prompt();
        continue;
      }

      // Slash commands
      if (input.startsWith("/")) {
        const handled = await handleSlashCommand(input, session, store, rl);
        if (!handled) break; // /exit
        rl.prompt();
        continue;
      }

      // Agent turn
      await runTurn(session, input, store);
      rl.prompt();
    }
  } finally {
    store.close();
  }
}

async function runTurn(session: AgentSession, input: string, store: HarnessStore): Promise<void> {
  const apiKey = getApiKey();
  if (!apiKey) {
    process.stdout.write("\n⚠️  DEEPSEEK_API_KEY is not set. Chat requires a DeepSeek API key.\n");
    process.stdout.write("   Set it in your environment and restart.\n");
    return;
  }

  const callbacks: AgentCallbacks = {
    onText: (text) => {
      process.stdout.write(text);
    },
    onToolStart: (name, _params) => {
      process.stdout.write(`\n  ⚙ ${name}...`);
    },
    onToolEnd: (_name, summary, error) => {
      if (error) {
        process.stdout.write(` ✗ ${summary}\n`);
      } else {
        process.stdout.write(` ✓ ${summary}\n`);
      }
    },
    onTurnEnd: (text, toolCalls, tokens) => {
      // Auto-generate session summary from first turn
      if (session.record.message_count <= 3) {
        const summary = input.slice(0, 80) + (input.length > 80 ? "..." : "");
        updateSessionSummary(session, summary);
      }
    },
  };

  try {
    await agentTurn(session, apiKey, input, callbacks);
    process.stdout.write("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\nError: ${message}\n`);
  }
}

async function handleSlashCommand(
  input: string,
  session: AgentSession,
  store: HarnessStore,
  rl: readline.Interface
): Promise<boolean> {
  const [cmd, ...args] = input.slice(1).split(/\s+/);

  switch (cmd) {
    case "exit":
    case "quit":
      process.stdout.write("Goodbye.\n");
      rl.close();
      return false;

    case "help":
      process.stdout.write(`
Commands:
  /help          Show this help
  /model [name]  Show or set model (flash|pro)
  /cost          Show session cost
  /list          List recent sessions
  /resume <id>   Resume a different session
  /exit          Exit chat
`);
      return true;

    case "model":
      if (args[0]) {
        const newModel = args[0] === "pro" ? "deepseek-v4-pro" : "deepseek-v4-flash";
        // Note: model changing requires session recreation — for now just inform
        process.stdout.write(`Model changes apply to new sessions. Current: ${session.model}\n`);
      } else {
        process.stdout.write(`Current model: ${session.model}\n`);
      }
      return true;

    case "cost":
      process.stdout.write(`Session cost: $${session.record.total_cost_usd.toFixed(6)} (${session.record.total_tokens} tokens)\n`);
      return true;

    case "list": {
      const sessions = listSessions(store, 10);
      for (const s of sessions) {
        const marker = s.id === session.id ? " *" : "  ";
        process.stdout.write(`${marker} ${s.id}  ${s.updated_at.slice(0, 19)}  ${s.model.padEnd(18)}  $${s.total_cost_usd.toFixed(4)}  ${s.summary || "-"}\n`);
      }
      return true;
    }

    default:
      process.stdout.write(`Unknown command: /${cmd}. Type /help for available commands.\n`);
      return true;
  }
}
```

- [ ] **Step 2: Build and verify**

```bash
cd /Users/tyler/Code/control-plane/deepseek-harness-productise
npm run typecheck
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/agent/cli.ts
git commit -m "feat(agent): add chat REPL with slash commands"
```

---

### Task 10: CLI integration — wire "chat" into main CLI

**Files:**
- Modify: `src/cli.ts`

**Goal:** Add `"chat"` to the command dispatch. Minimal change — one new entry in COMMANDS, one new flag set, one case in the switch.

- [ ] **Step 1: Add chat to COMMANDS and flags**

In `src/cli.ts`, line 57-80 (the `COMMANDS` array), add `"chat"`:

```typescript
const COMMANDS = [
  "chat",        // <-- ADD THIS
  "quickstart",
  "capabilities",
  // ... rest unchanged
] as const;
```

- [ ] **Step 2: Add CHAT_FLAGS**

After the `CORPUS_FLAGS` definition (around line 158), add:

```typescript
const CHAT_FLAGS: Record<string, readonly string[]> = {
  chat: ["resume", "list", "model"]
};
```

- [ ] **Step 3: Merge CHAT_FLAGS into COMMAND_FLAGS**

Modify `COMMAND_FLAGS` to include `CHAT_FLAGS` at the end of its definition:

```typescript
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  // ... existing entries ...
  ...CHAT_FLAGS,
};
```

- [ ] **Step 4: Add chat case to main() dispatch**

In `main()` at the switch statement (~line 254), add before `default`:

```typescript
    case "chat": {
      const { chatCommand } = await import("./agent/cli.js");
      await chatCommand({
        sessionId: optionalString(args.flags.resume),
        model: optionalModel(args.flags.model) as string | undefined,
        list: Boolean(args.flags.list),
        prompt: args.positional.length > 0 ? args.positional.join(" ") : undefined,
      });
      // chatCommand handles its own output, so don't write JSON to stdout
      return; // <-- return early, don't fall through to stdout.write
    }
```

- [ ] **Step 5: Update helpText() to include chat**

In the `helpText()` function, add chat to the "Start here" section:

```typescript
Start here:
  chat                    Start an interactive coding session
  quickstart              Run a local fake canary and return proof artefacts
```

- [ ] **Step 6: Build and run typecheck**

```bash
cd /Users/tyler/Code/control-plane/deepseek-harness-productise
npm run typecheck
```

Expected: No errors.

- [ ] **Step 7: Run full test suite to confirm zero regressions**

```bash
npm test
```

Expected: All existing tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts
git commit -m "feat(cli): integrate chat command into main CLI dispatch"
```

---

### Task 11: End-to-end test

**Files:**
- Create: `test/agent-chat.test.ts`

**Goal:** Verify the agent modules work together. Test the loop, context, tools, and session state without needing a live API key. Uses fake/dry-run approaches where possible.

- [ ] **Step 1: Create integration tests**

```typescript
// test/agent-chat.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessStore } from "../src/store.js";
import { createSession, addUserMessage, loadMessages, addAssistantMessage, addToolResult } from "../src/agent/session.js";
import { buildContext } from "../src/agent/context.js";
import { createToolRegistry } from "../src/agent/tools.js";
import { dispatchSubagent } from "../src/agent/dispatch.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-chat-"));
}

test("session creates and persists messages", () => {
  const stateDir = tempDir();
  const store = new HarnessStore(stateDir);
  try {
    const session = createSession(store, "/tmp/test-project", "deepseek-v4-flash");
    assert.ok(session.id.startsWith("sess_"));
    assert.equal(session.model, "deepseek-v4-flash");

    addUserMessage(session, "Hello, can you help?");
    addAssistantMessage(session, "Of course!", null, 5);
    addUserMessage(session, "Read the file please");
    addAssistantMessage(session, null, [
      { id: "call_1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ file_path: "/tmp/foo.txt" }) } }
    ], 15);
    addToolResult(session, "call_1", "file contents here");

    const msgs = loadMessages(session);
    assert.equal(msgs.length, 5);
    assert.equal(msgs[0].role, "user");
    assert.equal(msgs[0].content, "Hello, can you help?");
    assert.equal(msgs[3].role, "assistant");
    assert.ok(msgs[3].tool_calls);
    assert.equal(msgs[4].role, "tool");
  } finally {
    store.close();
  }
});

test("buildContext assembles system prompt, pinned files, and history", () => {
  const stateDir = tempDir();
  const store = new HarnessStore(stateDir);
  try {
    // Create a mock AGENTS.md
    const projectDir = tempDir();
    fs.writeFileSync(path.join(projectDir, "AGENTS.md"), "# Test Project\n\nThese are workspace instructions.", "utf8");

    const session = createSession(store, projectDir, "deepseek-v4-flash");
    addUserMessage(session, "hello");

    const ctx = buildContext(session);
    assert.ok(ctx.messages.length >= 2); // system prompt + project context + user message
    const systemMsg = ctx.messages[0];
    assert.equal(systemMsg.role, "system");
    assert.ok(systemMsg.content?.includes("DeepSeek Harness Chat"));
    assert.ok(ctx.messages.some((m) => m.content?.includes("Test Project")));
    assert.ok(ctx.messages.some((m) => m.content === "hello"));
  } finally {
    store.close();
  }
});

test("tool registry describes all 8 tools", () => {
  const registry = createToolRegistry();
  const described = registry.describe();
  assert.equal(described.length, 8);
  const names = described.map((d) => d.function.name).sort();
  assert.deepStrictEqual(names, [
    "delete_file",
    "edit_file",
    "list_directory",
    "read_file",
    "run_command",
    "search_content",
    "search_files",
    "write_file",
  ]);
});

test("read_file tool works", async () => {
  const registry = createToolRegistry();
  const dir = tempDir();
  const filePath = path.join(dir, "test.txt");
  fs.writeFileSync(filePath, "line one\nline two\n", "utf8");

  const result = await registry.execute("read_file", { file_path: filePath }, dir);
  assert.equal(result.error, undefined);
  assert.ok(result.content.includes("line one"));
  assert.ok(result.summary.includes("test.txt"));
});

test("write_file tool creates file", async () => {
  const registry = createToolRegistry();
  const dir = tempDir();
  const filePath = path.join(dir, "nested", "out.txt");

  const result = await registry.execute("write_file", { file_path: filePath, content: "test content" }, dir);
  assert.equal(result.error, undefined);
  assert.equal(fs.readFileSync(filePath, "utf8"), "test content");
});

test("edit_file replaces text", async () => {
  const registry = createToolRegistry();
  const dir = tempDir();
  const filePath = path.join(dir, "edit.txt");
  fs.writeFileSync(filePath, "const A = 1;\nconst B = 2;\n", "utf8");

  const result = await registry.execute("edit_file", {
    file_path: filePath,
    old_string: "const A = 1;",
    new_string: "const A = 42;",
  }, dir);
  assert.equal(result.error, undefined);
  assert.ok(fs.readFileSync(filePath, "utf8").includes("const A = 42;"));
});

test("delete_file blocked without tier 2 approval", async () => {
  const registry = createToolRegistry();
  const dir = tempDir();
  const filePath = path.join(dir, "target.txt");
  fs.writeFileSync(filePath, "keep me", "utf8");

  const result = await registry.execute("delete_file", { file_path: filePath }, dir);
  assert.ok(result.error);
  assert.ok(result.error.includes("approval_required"));
  assert.ok(fs.existsSync(filePath)); // file still exists
});

test("dispatchSubagent blocked without API key", async () => {
  // Save and clear API key to test blocking
  const originalKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const result = await dispatchSubagent({
      task: "Write a hello world function in TypeScript",
    });
    assert.equal(result.status, "BLOCKED");
    assert.ok(result.blocker?.includes("DEEPSEEK_API_KEY"));
  } finally {
    if (originalKey) process.env.DEEPSEEK_API_KEY = originalKey;
  }
});
```

- [ ] **Step 2: Run the new tests**

```bash
cd /Users/tyler/Code/control-plane/deepseek-harness-productise
npm run build
node --test dist/test/agent-chat.test.js
```

Expected: All tests pass.

- [ ] **Step 3: Run full suite**

```bash
npm test
```

Expected: All tests pass (existing + new).

- [ ] **Step 4: Commit**

```bash
git add test/agent-chat.test.ts
git commit -m "test(agent): add integration tests for chat agent modules"
```

---

### Task 12: Documentation update

**Files:**
- Modify: `docs/user-guide.md`
- Modify: `src/product.ts`

**Goal:** Document the chat command in the user guide and add it to the capabilities output.

- [ ] **Step 1: Update user guide**

Add after the "Start here" section in `docs/user-guide.md`:

```markdown
## Interactive Chat (NEW in v0.1.0)

Start an interactive coding session:

```bash
deepseek-harness chat
```

The chat agent can read, write, edit, and search files in your project. It uses
DeepSeek V4 Flash by default and escalates to Pro for complex reasoning.

### Session management

```bash
deepseek-harness chat                    # New session
deepseek-harness chat --resume           # Pick from recent sessions
deepseek-harness chat --resume sess_abc  # Resume specific session
deepseek-harness chat --list             # List all sessions
deepseek-harness chat --model pro        # Force Pro model
deepseek-harness chat "fix the lint errors"  # One-shot
```

### Slash commands

| Command | Action |
|---------|--------|
| `/help` | Show available commands |
| `/model` | Show current model |
| `/model flash` | Switch to Flash (new sessions) |
| `/cost` | Show session cost and token usage |
| `/list` | List recent sessions |
| `/exit` | Exit chat |

### Safety

- Read, write, and edit operations execute directly with your file permissions.
- Destructive operations (delete, git push, npm publish) require explicit approval.
- Live DeepSeek API calls require `DEEPSEEK_API_KEY` in your environment.
- Cost is tracked per session in real time.
```

- [ ] **Step 2: Update product capabilities**

In `src/product.ts`, in the `productCapabilities()` function, add `chat` to the `interfaces` array:

```typescript
interfaces: ["cli", "mcp_stdio", "chat_repl"]
```

And add a chat workflow to the `workflows` array:

```typescript
{
  id: "interactive_coding",
  use_when: "You need an AI coding partner that reads, writes, edits, and searches your codebase.",
  cli: "deepseek-harness chat",
  network: "live_deepseek_required",
  notes: "Requires DEEPSEEK_API_KEY. Cost tracked per session."
}
```

- [ ] **Step 3: Build and verify**

```bash
cd /Users/tyler/Code/control-plane/deepseek-harness-productise
npm run typecheck
npm test
```

Expected: All tests pass.

- [ ] **Step 4: Final commit**

```bash
git add docs/user-guide.md src/product.ts
git commit -m "docs: add chat command to user guide and capabilities"
```

---

## Self-Review Checklist

After all tasks are complete, verify:

1. `npm run typecheck` — passes
2. `npm test` — all tests pass (existing + new)
3. `npm run pack:check` — package allow-list still valid
4. `deepseek-harness help` — shows "chat" in command list
5. `deepseek-harness chat --list` — works (shows no sessions or existing ones)
6. No changes to existing batch/corpus behaviour

