#!/usr/bin/env node
// MorpheOS Code — Captain Zeus at the helm
// Launch: `morpheos` (TUI) or `morpheos --json "prompt"` (agent mode)

import { HarnessStore } from "../dist/src/store.js";
import { createSession, resumeSession, listSessions } from "../dist/src/agent/session.js";
import { getApiKey } from "../dist/src/agent/stream.js";

const STATE_DIR = process.env.DEEPSEEK_HARNESS_STATE_DIR ?? ".state";
const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

function positionalArgs(): string[] {
  const skip = new Set(["--help", "-h", "--list", "--json", "--session", "--model"]);
  const consumed = new Set<string>();
  for (const name of ["session", "model"]) {
    const idx = args.indexOf(`--${name}`);
    if (idx >= 0) {
      consumed.add(idx.toString());
      consumed.add((idx + 1).toString());
    }
  }
  return args.filter((a, i) => !skip.has(a) && !consumed.has(i.toString()));
}

async function main() {
  if (hasFlag("help") || args.includes("-h")) {
    process.stdout.write(`⚡ MorpheOS Code — Captain Zeus at the helm

Usage (human):
  morpheos                        Start TUI session
  morpheos --resume ID            Resume a session in TUI
  morpheos --list                 List recent sessions
  morpheos --model pro            Use Pro engines (TUI)

Usage (agent):
  morpheos --json "fix the bug"               One-shot, JSON output
  morpheos --json "refactor auth" --session my-project   Named session
  morpheos --json "review this" --model pro              Use Pro

Requirements:
  DEEPSEEK_API_KEY         Set in your environment
  Node.js >= 24

Get a key: https://platform.deepseek.com/api_keys
`);
    return;
  }

  const store = new HarnessStore(STATE_DIR);
  try {
    // --list
    if (hasFlag("list")) {
      const sessions = listSessions(store, 20);
      if (sessions.length === 0) {
        process.stdout.write("No previous voyages found.\n");
      } else {
        for (const s of sessions) {
          process.stdout.write(`${s.id}  ${s.updated_at.slice(0, 19)}  ${s.model}  £${s.total_cost_usd.toFixed(4)}  ${s.summary || "-"}\n`);
        }
      }
      return;
    }

    const apiKey = getApiKey();
    if (!apiKey) {
      process.stderr.write("DEEPSEEK_API_KEY is not set. Grab one at https://platform.deepseek.com/api_keys\n");
      process.exit(1);
    }

    // ── Agent mode (--json) ──
    if (hasFlag("json")) {
      const { agentChat } = await import("../dist/src/agent/agent-mode.js");
      const prompt = positionalArgs().join(" ");
      if (!prompt) {
        process.stderr.write("Error: --json requires a prompt argument.\nUsage: morpheos --json \"your prompt here\"\n");
        process.exit(2);
      }
      const result = await agentChat({
        prompt,
        session: flag("session"),
        model: flag("model") === "pro" ? "deepseek-v4-pro" : flag("model") === "flash" ? "deepseek-v4-flash" : undefined,
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      process.exit(result.ok ? 0 : 1);
    }

    // ── Human mode (TUI) ──
    const sessionId = flag("resume");
    const model = flag("model") === "pro" ? "deepseek-v4-pro" : "deepseek-v4-flash";
    const session = sessionId
      ? resumeSession(store, sessionId)
      : createSession(store, process.cwd(), model);

    const { runTui } = await import("../dist/src/agent/tui.js");
    await runTui(session, apiKey);
  } finally {
    store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
