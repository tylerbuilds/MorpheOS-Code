#!/usr/bin/env node
// MorpheOS Code — Captain Zeus at the helm
// Launch the TUI directly: `morpheos` or `morpheos --resume sess_abc`

import { HarnessStore } from "../dist/src/store.js";
import { createSession, resumeSession } from "../dist/src/agent/session.js";
import { getApiKey } from "../dist/src/agent/stream.js";
import { runTui } from "../dist/src/agent/tui.js";

const STATE_DIR = process.env.DEEPSEEK_HARNESS_STATE_DIR ?? ".state";
const args = process.argv.slice(2);

async function main() {
  // --help
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`⚡ MorpheOS Code — Captain Zeus at the helm

Usage:
  morpheos                 Start a new session
  morpheos --resume ID     Resume a session
  morpheos --list          List recent sessions
  morpheos --model pro     Use Pro engines
  morpheos "fix the bug"   One-shot (plain mode)

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
    if (args.includes("--list")) {
      const sessions = store.listSessions(20);
      if (sessions.length === 0) {
        process.stdout.write("No previous voyages found.\n");
      } else {
        for (const s of sessions) {
          process.stdout.write(`${s.id}  ${s.updated_at.slice(0, 19)}  ${s.model}  £${s.total_cost_usd.toFixed(4)}  ${s.summary || "-"}\n`);
        }
      }
      return;
    }

    // Resolve model
    const modelIdx = args.indexOf("--model");
    const model = modelIdx >= 0 ? (args[modelIdx + 1] === "pro" ? "deepseek-v4-pro" : "deepseek-v4-flash") : "deepseek-v4-flash";

    // Create or resume session
    const resumeIdx = args.indexOf("--resume");
    const session = resumeIdx >= 0
      ? resumeSession(store, args[resumeIdx + 1])
      : createSession(store, process.cwd(), model);

    const apiKey = getApiKey();
    if (!apiKey) {
      process.stderr.write("DEEPSEEK_API_KEY is not set. Grab one at https://platform.deepseek.com/api_keys\n");
      process.exit(1);
    }

    // One-shot mode: prompt as positional arg
    const prompt = args.filter(a => !a.startsWith("--") && a !== args[resumeIdx + 1]).join(" ");
    if (prompt && !args.includes("--resume") && resumeIdx < 0) {
      // One-shot plain mode
      const { chatCommand } = await import("../dist/src/agent/cli.js");
      await chatCommand({ prompt, model });
      return;
    }

    // Full TUI
    await runTui(session, apiKey);
  } finally {
    store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
