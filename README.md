# ⚡ MorpheOS Code

> Captain Zeus at the helm. A first-class coding TUI powered by DeepSeek V4.
> Batch processing, corpus ingestion, and MCP tools under the hood.

`deepseek-harness chat` drops you into a full-screen terminal interface with
streaming responses, file editing, shell commands, subagent dispatch, and a
British captain's dry wit. Built on a battle-tested batch engine with 873
passing tests and adversarial hardening across every module.

<p align="center">
  <strong>873 tests · 0 failures · MIT licensed · Node 24+</strong>
</p>

---

## Quick start

```bash
git clone https://github.com/tylerbuilds/MorpheOS-Code.git
cd MorpheOS-Code
bash scripts/install-local.sh --install-dir "$HOME/bin" --force
export PATH="$HOME/bin:$PATH"
export DEEPSEEK_API_KEY="sk-..."  # Get one at platform.deepseek.com
morpheos
```

You're on the bridge. Type `/help` for commands, `/settings` for the keyboard
settings panel, `/model pro` to engage the Pro reactors.

---

## What it is

**MorpheOS Code** is a three-layer tool:

| Layer | What it does | Entry point |
|---|---|---|
| **Chat TUI** | Interactive coding agent with streaming, 8 tools, session persistence, cost tracking, keyboard settings panel | `deepseek-harness chat` |
| **Batch engine** | High-throughput parallel DeepSeek inference with manifests, SQLite state, approval receipts, cost ledgers | `deepseek-harness plan/submit/work` |
| **Corpus runner** | Resumable heavy-work processing: books, OCR, translation, JSONL, long-form, media catalogues | `deepseek-harness corpus ingest/plan/start` |

The chat agent is the headline. The batch and corpus engines are the proven
infrastructure it runs on — they share the same transport, store, approval,
and safety layers.

---

## Chat agent

```
⚡ MorpheOS Code                    standing by · Flash
┌──────────────────────────────────────────────────────┐
│ user › inspect the AGENTS.md and tell me what the    │
│        project does                                  │
│ zeus › Right then. Let's have a look at the charts.  │
│   ⚙ read_file /Users/tyler/project/AGENTS.md        │
│   ✓ Read 42 lines from AGENTS.md                    │
│ zeus › This vessel is a DeepSeek-powered coding      │
│        harness, Captain. The AGENTS.md lays out…     │
│                                                      │
│                                                      │
│                                                      │
│                                                      │
├───────────────────────────┬──────────────────────────┤
│                           │ Captain's Log            │
│                           │ sess_a1b2…               │
│                           │ Flash engines            │
│                           │ £0.000342                │
│                           │ 1,500 tokens             │
│                           │ Cargo Bay                │
│                           │ empty                    │
└───────────────────────────┴──────────────────────────┘
❯ inspect the repo                            Ctrl+C exit · /help
```

### What it can do

- **Read, write, edit, search files** — with line numbers, exact string replacement, ripgrep
- **Run shell commands** — 14 destructive patterns permanently blocked (rm -rf, sudo, curl|sh, force push…)
- **Switch models mid-session** — `/model pro` engages DeepSeek V4 Pro
- **Show thinking** — `/thinking` reveals the model's reasoning tokens
- **Settings panel** — `/settings` opens keyboard-navigable configuration (↑↓←→ Esc)
- **Persist sessions** — resume with `--resume`, browse with `--list`, SQLite-backed
- **Track costs** — `/cost` shows fuel consumed in real time
- **Dispatch subagents** — parallel task execution through the batch engine

### Safety

The chat agent is adversarial-hardened:

- **14 destructive command patterns** permanently blocked at the tool level
- **Tier 2 tools** (delete, destructive shell commands) require explicit approval
- **Path traversal** blocked — all file operations resolve paths within workspace
- **Shell injection** prevented — `search_content` and `search_files` use execFileSync
- **873 adversarial tests** across 17 modules, zero failures
- **Foreign key enforcement**, null-byte truncation, NaN/Infinity guards

### Slash commands

| Command | Action |
|---|---|
| `/help` | Show all commands |
| `/settings` | Keyboard settings panel (model, thinking) |
| `/model flash\|pro` | Switch engines |
| `/thinking` | Toggle reasoning visibility |
| `/cost` | Show fuel consumed |
| `/sessions` | List previous voyages |
| `/clear` | Clear the transcript |
| `/exit` | Leave the bridge |

---

## Agent-native mode

MorpheOS Code is built to be driven by other AI agents. Any agent that can
run a CLI command can control Captain Zeus via structured JSON:

```bash
# One-shot: agent gets structured JSON back
morpheos --json "fix the authentication bug in src/auth.ts"

# Multi-turn: agent maintains session continuity
morpheos --json "review the PR" --session code-review-42
morpheos --json "now implement the fixes" --session code-review-42

# Force Pro model for complex reasoning
morpheos --json "architect the new payment system" --model pro
```

Output is machine-readable JSON:

```json
{
  "ok": true,
  "session_id": "sess_abc123",
  "model": "deepseek-v4-flash",
  "response": "Right then, Captain. The auth bug was in...",
  "tool_calls": [
    {
      "name": "read_file",
      "params": {"file_path": "/project/src/auth.ts"},
      "result": "import bcrypt from...",
      "summary": "Read 142 lines from auth.ts"
    }
  ],
  "usage": {"prompt_tokens": 450, "completion_tokens": 200, "total_tokens": 650},
  "cost_usd": 0.000715,
  "session_cost_usd": 0.001430,
  "session_tokens": 1300
}
```

### MCP tool

Agents using the Model Context Protocol can call `morpheos_chat` directly:

```json
{
  "method": "tools/call",
  "params": {
    "name": "morpheos_chat",
    "arguments": {
      "prompt": "fix the auth bug",
      "session": "code-review-42"
    }
  }
}
```

Generate MCP config:

```bash
deepseek-harness mcp-config --profile full
```

### Why agents love it

- **Structured output** — every response is valid JSON with typed fields
- **Session continuity** — `--session` flag maintains context across calls
- **Tool transparency** — every file read, edit, and command is in the response
- **Cost tracking** — per-call and cumulative session costs
- **Exit codes** — 0 for success, 1 for error, 2 for usage, 3 for safety block
- **Same machine** — runs locally alongside the agent, no network latency for tools
- **Not OpenClaw-specific** — works with any agent that can exec a CLI command

## Batch engine

The same engine that powers the chat agent is available as a standalone batch
CLI with MCP tool surface. Used for high-throughput parallel inference,
cost-tracked runs, and audit-ready review packets.

```bash
deepseek-harness plan examples/basic-run.json
deepseek-harness submit examples/basic-run.json --start
deepseek-harness status <run_id>
deepseek-harness results <run_id>
deepseek-harness cost-ledger <run_id>
deepseek-harness export-review-packet <run_id>
```

Live DeepSeek calls require signed one-use approval receipts, privacy
classification, cost caps, and concurrency limits. The harness stores
consumption records and budget reservations before any network call.

See [docs/operator-guide.md](docs/operator-guide.md) for the full safety
contract and configuration.

---

## Corpus runner

Resumable heavy-work processing for books, OCR, translation, JSONL datasets,
long-form authoring, and media catalogues. Shard-level checkpointing with
crash-safe locks and bounded supervision.

```bash
deepseek-harness corpus ingest-book war-and-peace.txt --project tolstoy --chunk-chars 12000
deepseek-harness corpus plan examples/corpus-basic.json
deepseek-harness corpus start examples/corpus-basic.json
deepseek-harness corpus work <job_id> --max-iterations 100
deepseek-harness corpus validate <job_id>
deepseek-harness corpus reconcile <job_id>
deepseek-harness corpus supervise --once --max-jobs-per-cycle 4
```

See [docs/corpus-heavy-workloads.md](docs/corpus-heavy-workloads.md) for the
full corpus lifecycle.

---

## MCP integration

The harness exposes a stdio MCP server with 39 tools across three profiles:

| Profile | Tools | For |
|---|---|---|
| `core` | 20 | General agents — discovery, batch, safety, proof, benchmark |
| `corpus` | 22 | Corpus operators — ingest, plan, start, validate, reconcile |
| `full` | 39 | Agents needing both planes |

Generate configuration for your MCP client:

```bash
deepseek-harness mcp-config --format json --profile core
deepseek-harness mcp-config --format codex-toml --profile full
```

---

## Development

```bash
npm ci
npm run build
npm test                    # Full suite: 873 tests
npm run typecheck
npm run mcp:smoke
npm run pack:check
cargo test --locked         # Rust worker tests
```

### Project structure

```
src/
├── agent/          # Chat TUI, agent loop, tools, streaming, sessions
│   ├── cli.ts      # Plain CLI fallback
│   ├── tui.tsx     # Ink-based full-screen TUI
│   ├── tui-state.ts # TUI state machine
│   ├── loop.ts     # Core agent think→act→observe cycle
│   ├── tools.ts    # 8 tools + command safety gate + tiered execution
│   ├── stream.ts   # DeepSeek SSE streaming client
│   ├── session.ts  # SQLite-backed session persistence
│   ├── context.ts  # Sliding window context assembly
│   ├── dispatch.ts # Subagent spawning
│   ├── prompts.ts  # Captain Zeus personality templates
│   ├── theme.ts    # ANSI colour theme
│   └── events.ts   # Streaming event types
├── cli.ts           # Main CLI dispatch (plan, submit, corpus, chat…)
├── runner.ts        # Batch run orchestration
├── corpus*.ts       # Corpus adapters and lifecycle
├── store.ts         # SQLite store (runs, sessions, messages, budget)
├── transport.ts     # DeepSeek API transport (fake, dry-run, live)
├── approval.ts      # Signed receipt validation
├── privacy.ts       # Outbound privacy classification
├── cost.ts          # Token cost ledger
└── schema.ts        # Zod manifest validation

test/
├── adversarial/     # 824 adversarial tests across 18 modules
├── agent-*.test.ts  # Agent module tests
└── *.test.ts        # Core harness tests
```

---

## Why build on this

- **Fully local** — SQLite state, no cloud dependency (except DeepSeek API)
- **Battle-tested** — 873 tests, adversarial-hardened, 25+ bugs found and fixed
- **Extensible** — pluggable tool registry, Tier 1/Tier 2 gates, subagent dispatch
- **Cost-aware** — Flash/Pro routing, per-session cost tracking, budget ceilings
- **MIT licensed** — use it, fork it, ship it
- **TypeScript + Rust** — Node 24+ runtime with optional Rust worker crate
- **MCP-native** — 39 tools, profile-based surface, Codex/Claude compatible

## License

MIT — see [LICENSE](LICENSE).
