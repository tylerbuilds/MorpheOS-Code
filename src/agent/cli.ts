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

export interface ChatOptions {
  sessionId?: string;
  model?: string;
  list?: boolean;
  prompt?: string;
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
      await runTurn(session, options.prompt);
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
        if (!handled) break;
        rl.prompt();
        continue;
      }

      // Agent turn
      await runTurn(session, input);
      rl.prompt();
    }
  } finally {
    store.close();
  }
}

async function runTurn(session: AgentSession, input: string): Promise<void> {
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
    onTurnEnd: (_text, _toolCalls, _tokens) => {
      // Auto-generate session summary from first few turns
      if (session.record.message_count <= 5) {
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
  if (!cmd) return true;

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
