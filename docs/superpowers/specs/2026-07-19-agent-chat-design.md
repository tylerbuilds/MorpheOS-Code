# Agent Chat — Interactive Coding CLI for DeepSeek Harness

**Status:** approved  
**Date:** 2026-07-19  
**Spec version:** 1

## 1. Summary

Add an interactive chat/REPL coding agent (`deepseek-harness chat`) to the existing DeepSeek Harness CLI. The agent layer is a consumer of the existing harness (transport, store, approval, cost, product) — it does not replace or modify the batch/corpus tooling. The result is a unified platform: `chat` for interactive coding, `plan`/`submit`/`corpus` for batch and heavy work, all sharing the same transport, state, cost, and safety layers.

## 2. Motivation

The harness already has proven infrastructure for DeepSeek API calls, SQLite state, cost tracking, signed approval, and bounded concurrency. What's missing is an interactive agentic loop — the ability to have a multi-turn conversation with DeepSeek that reads code, edits files, runs commands, and dispatches subagents for parallel work. This turns the harness from a batch processor into a daily-driver coding CLI comparable to Claude Code, differentiated by:

- **Cost-aware model routing** — Flash for 80% of turns, Pro for complex reasoning, with real-time cost display.
- **Heavy job capability** — Corpus infrastructure for resumable, sharded processing of large codebases and long-running tasks.
- **Subagent parallelism** — Dispatch subagents as harness batch jobs with bounded concurrency for parallel task execution.

## 3. Architecture

### 3.1 New subsystem: `src/agent/`

```
src/agent/
├── loop.ts          — Core think→act→observe cycle with streaming
├── tools.ts         — Tool registry, tiered execution router
├── context.ts       — Sliding window, summarisation, truncation
├── session.ts       — Create, resume, fork, list sessions
├── dispatch.ts      — Subagent spawning via harness batch runner
├── cli.ts           — Chat REPL, command parsing, signal handling
└── prompts.ts       — System prompt templates
```

### 3.2 Relationship with existing harness

The agent layer is a **consumer**, not a replacement. Zero changes to existing modules unless bugs are found.

```
deepseek-harness chat          ← NEW (src/agent/*)
         │
         ├──► transport.ts     ← Existing: DeepSeek API calls
         ├──► store.ts         ← Existing: SQLite state (sessions, messages)
         ├──► approval.ts      ← Existing: Tier-2 tool gating
         ├──► cost.ts          ← Existing: Token/cost tracking
         └──► product.ts       ← Existing: Model routing, capabilities

deepseek-harness plan|submit|corpus|...  ← Unchanged
```

Existing `mcp.ts` and `runner.ts` are NOT called by the agent — the agent has its own tool loop. The harness MCP server remains for external agent consumers; the chat agent is an internal consumer.

### 3.3 Data flow

```
User input (terminal)
      │
      ▼
  Context builder (context.ts)
  - Sliding window of messages
  - Truncation/summarisation as needed
      │
      ▼
  DeepSeek API via transport.ts
  - Flash for simple turns, Pro for complex
  - Streaming tokens → terminal
      │
      ▼
  Response contains tool calls?
      │
   NO ──► Display to user, wait for next input
      │
     YES
      │
      ▼
  Tool router (tools.ts)
  ┌──────────────────────────────┐
  │ Tier 1: read_file, write_file│
  │   edit_file, search_content, │
  │   search_files, run_command, │──► Execute directly
  │   list_directory             │
  │                              │
  │ Tier 2: delete_file, git_push│
  │   npm_publish, live_api_call │──► Route through approval.ts
  └──────────────────────────────┘
      │
      ▼
  Tool result → appended to context
      │
      ▼
  Loop back to DeepSeek API
```

## 4. Agent Loop

### 4.1 Core cycle

```
1. Build context (system prompt + pinned files + message history + tool results)
2. Call DeepSeek API with streaming
3. Render text tokens to terminal as they arrive
4. If response has tool calls:
   a. Execute each tool (parallel for independent calls)
   b. Append tool results to context
   c. Go to step 2
5. If response has no tool calls: turn complete, wait for user input
```

### 4.2 Model selection per turn

- **Flash** is the default for every turn.
- **Pro** is selected when: the context exceeds ~16K tokens, the model's tool calls reference 3+ distinct file paths in a single response, the user explicitly requests reasoning or deep analysis, or the last 3 consecutive turns used Pro (continuity — don't flip-flop).
- The routing logic lives in `src/agent/loop.ts` and calls `selectModel()` which uses heuristics, not a separate API call.
- The user can override: `deepseek-harness chat --model pro`.

### 4.3 Streaming

- Text tokens render to stdout as they arrive via the existing `transport.ts` streaming support.
- Tool calls render inline: a spinner while executing, then a compact result summary.
- The user sees the model "thinking" and "acting" in real time.

## 5. Tool Registry

### 5.1 Tool definition

```typescript
interface Tool {
  name: string;
  description: string;        // For the model's tool definition
  parameters: ZodSchema;      // Validated input
  tier: 1 | 2;                // Direct or approval-gated
  execute(params, session): Promise<ToolResult>;
}

interface ToolResult {
  content: string;            // Full result text
  summary: string;            // Compact display (e.g., "Read 42 lines from foo.ts")
  error?: string;             // If execution failed
}
```

### 5.2 Tier 1 tools (direct execution)

| Tool | Description | Notes |
|---|---|---|
| `read_file` | Read a file with line numbering | Accepts absolute paths. Returns cat -n format. |
| `write_file` | Write or overwrite a file | Creates parent dirs. Warns if overwriting. |
| `edit_file` | Exact string replacement | Like Claude Code's Edit. old_string must be unique. Fails otherwise. |
| `search_content` | ripgrep/grep with glob patterns | Falls back to grep if rg unavailable. |
| `search_files` | find/glob by filename | Returns relative paths. |
| `run_command` | Execute a shell command | Timeout (default 120s, max 600s). Sandboxed when possible. |
| `list_directory` | List directory contents | Returns names with file/dir/symlink indicators. |

### 5.3 Tier 2 tools (approval-gated)

| Tool | Description | Gate |
|---|---|---|
| `delete_file` | Delete a file permanently | Requires signed approval receipt |
| `git_push` | Push to remote | Requires signed approval receipt |
| `npm_publish` | Publish to npm registry | Requires signed approval receipt |
| `live_api_call` | Any external API call | Requires one-use signed receipt |

Tier 2 tools call into the existing `src/approval.ts`. If no valid one-use receipt is present, the tool returns a structured denial. The model presents this to the user naturally ("I can't push that — live operations haven't been authorised for this session. Run `deepseek-harness approval-packet` first.").

### 5.4 Parallel execution

Independent tool calls within a single model response execute in parallel (e.g., read 3 files simultaneously). Dependent calls (where one tool's output is another's input) cannot be detected — the model is expected to sequence them across turns. Max parallel tool calls is bounded by the harness's existing concurrency cap.

## 6. Context Management

### 6.1 Context window structure

```
Full context window (up to 128K tokens for DeepSeek V4)
├── System prompt              (~2K tokens, immutable per session)
├── Pinned project context     (AGENTS.md, CLAUDE.md, package.json, etc.)
├── Recent messages            (last 20-30 turns, verbatim)
├── Summarised history         (older turns, compressed by Flash)
└── Tool results               (last 20 results, older summarised)
```

### 6.2 Sliding window

- Keep the last 25 messages (user + assistant + tool pairs) verbatim.
- When the window exceeds 75% of the model's context limit, trigger async summarisation of older messages.
- Tool calls and their results must never be separated — they are truncated or kept as a pair.

### 6.3 Summarisation

- Runs as a background Flash call. The user is not blocked.
- Produces a ~500-token summary of older conversation that replaces the verbatim history.
- Cached per session to avoid re-summarising on every turn.
- If a summarisation call fails, the oldest messages are dropped without summarisation (degraded but not broken).

### 6.4 Project context discovery

At session start, the agent reads:
- `AGENTS.md` (workspace instructions)
- `CLAUDE.md` / `GEMINI.md` / `COPILOT.md` if present
- `package.json`, `tsconfig.json`, or equivalent project root files

These are pinned at the top of the context window and never truncated.

## 7. Sessions

### 7.1 Session model

Sessions are stored in the existing SQLite store (`src/store.ts`) via new tables.

```typescript
interface Session {
  id: string;              // UUID
  created_at: string;      // ISO 8601
  updated_at: string;      // ISO 8601
  cwd: string;             // Working directory at session start
  model: string;           // "deepseek-v4-flash" | "deepseek-v4-pro"
  summary: string;         // Auto-generated one-line description
  message_count: number;
  total_tokens: number;
  total_cost_usd: number;
}
```

Messages are stored as rows with role, content, tool calls, and token counts. Cost tallies use the existing `cost.ts` module.

### 7.2 CLI surface

```
deepseek-harness chat                      # New session in current directory
deepseek-harness chat --resume             # Interactive picker from recent sessions
deepseek-harness chat --resume sess_a1b    # Resume specific session
deepseek-harness chat --list               # Show all sessions with date, summary, cost
deepseek-harness chat --model pro          # Force Pro for this session
deepseek-harness chat "fix the auth bug"   # One-shot, non-interactive
```

## 8. Subagent Dispatch

### 8.1 When subagents are used

The chat agent spawns subagents when:
- The user explicitly asks to implement a plan file (`deepseek-harness chat "implement docs/plan.md"`)
- The model determines parallel work is needed (e.g., "refactor auth AND add rate limiting" — two independent tasks)
- The subagent-driven-development skill's workflow is triggered

### 8.2 Dispatch mechanics

```typescript
async function dispatchSubagent(params: {
  task: string;            // Exactly what to do
  context: ContextPack;    // Curated files, plan excerpt, etc.
  model?: string;          // Defaults to Flash for mechanical, Pro for judgment
  tools?: string[];        // Tool allow-list (default: read-only + bash)
}): Promise<SubagentResult>
```

Each subagent:
- Gets a fresh, isolated prompt (no chat history inheritance)
- Has a restricted tool set (read/search/bash by default; write/edit if explicitly authorised)
- Returns one of: `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, `BLOCKED`
- The orchestrating agent handles each status per the subagent-driven-development skill

### 8.3 Review flow

When using the subagent-driven-development workflow:
1. Implementer subagent writes code → returns `DONE` or escalates
2. Spec compliance reviewer subagent checks against plan → approves or returns issues
3. Code quality reviewer subagent checks implementation → approves or returns issues
4. The orchestrating agent presents findings in chat

Subagents run as independent harness transport calls. Concurrency is bounded by the existing harness limits (default 1 for corpus, configurable for agent subagents).

## 9. CLI Integration

### 9.1 Changes to existing CLI

The only change to `src/cli.ts` is:
- Add `"chat"` to the `COMMANDS` array
- Add a `"chat"` case in the dispatch switch (line ~233)
- Define `CHAT_FLAGS`: `["resume", "list", "model"]`

No other commands, flags, or modules are modified.

### 9.2 Exit codes

Chat uses the same exit code convention:
- `0` — normal exit (user typed `/exit` or Ctrl-D)
- `1` — runtime or API failure
- `2` — invalid flag or argument
- `3` — safety block (tier-2 tool denied without approval)

## 10. Performance Design

### 10.1 Latency budget per turn

| Phase | Target | How |
|---|---|---|
| Context assembly | <50ms | SQLite reads, no network |
| API request + first token | <500ms | DeepSeek Flash streaming |
| Tool execution (Tier 1) | <100ms per tool | Local fs/process, no network |
| Tool execution (Tier 2) | <200ms + approval check | Single SQLite read for receipt |
| Context summarisation | Background | Non-blocking Flash call |

### 10.2 Model cost optimisation

- Flash handles ~80% of turns by default
- Pro on-demand only when complexity warrants
- Summarisation always uses Flash (cheap, good enough)
- Subagents default to Flash; Pro only for judgment/review tasks
- Cost ledger updates in real time per the existing `cost.ts`

### 10.3 Parallelism

- Independent tool calls within a turn execute in parallel
- Subagents execute as independent concurrent tasks
- Context summarisation runs in background (non-blocking)

### 10.4 Local-first

- No cloud round trip for any tool execution
- Session state is local SQLite with WAL
- The only network hop is DeepSeek API for inference
- Offline mode: no network → error gracefully, suggest quickstart

## 11. What Is Out of Scope

- GUI / web interface — terminal only
- Voice interface
- Multi-provider routing (Claude, Gemini, etc.) — DeepSeek only
- Plugin system or dynamic tool loading
- Remote agent execution
- File watcher or proactive/auto context scanning
- Automatic git branch/commit/PR management (manual via tools only)
- Built-in code review beyond subagent-driven-development flow

## 12. Module Boundaries

### 12.1 `loop.ts`

- `agentLoop(session, input)` — main entry for a single user turn
- `selectModel(ctx)` — Flash vs Pro heuristic
- `streamChat(ctx, options)` — streaming DeepSeek call via transport.ts
- Pure functions where possible; side effects through tool execution

### 12.2 `tools.ts`

- `ToolRegistry` class with `register()`, `describe()`, `execute()`
- `execute(name, params, session)` — routes to tier 1 or tier 2 path
- Tool implementations are self-contained functions
- Tier 2 gating calls `approval.ts` externally

### 12.3 `context.ts`

- `buildContext(session, userInput)` — assembles full message array
- `summariseHistory(session)` — background Flash summarisation
- `discoverProjectContext(cwd)` — reads AGENTS.md, package.json, etc.
- Token counting reuses existing harness utilities

### 12.4 `session.ts`

- `createSession(cwd, model)` — new session in store
- `resumeSession(id)` — load existing session
- `listSessions(limit)` — recent sessions with metadata
- All storage through the existing `HarnessStore`

### 12.5 `dispatch.ts`

- `dispatchSubagent(params)` — spawn isolated subagent call
- `dispatchReview(params)` — spec or code quality review
- Returns structured result with status enum

### 12.6 `cli.ts`

- `chatCommand(args)` — entry point from main CLI dispatch
- REPL loop with readline
- `/exit`, `/help`, `/model`, `/cost` slash commands
- Ctrl-C, Ctrl-D handling

### 12.7 `prompts.ts`

- `systemPrompt(session)` — base system prompt with tool descriptions
- `subagentPrompt(task, context)` — prompt template for subagents
- Review prompts for spec and code quality reviewers

## 13. Testing Strategy

- Unit tests for each agent module (loop state transitions, tool routing, context assembly)
- Integration tests: mock DeepSeek API, verify full turn cycle
- E2E: `deepseek-harness chat "write a hello world script"` in a temp directory
- Existing test suite must continue to pass (183 tests, no regressions)
- New tests follow existing patterns (Node test runner, TypeScript)

## 14. Deliverables

1. Seven new modules in `src/agent/` as described in §3.1
2. One-line change to `src/cli.ts` (add `"chat"` command dispatch)
3. New store tables for sessions and messages
4. Tests for all new modules
5. Update `docs/user-guide.md` with chat usage
6. Update `product.ts` capabilities to list chat as an interface
