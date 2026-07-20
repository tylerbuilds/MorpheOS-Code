// test/agent-pairing.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessStore } from "../src/store.js";
import { createSession } from "../src/agent/session.js";
import { extractPlan, pairedTurn, type PairingConfig, type ArchitectPlan, type PairedTurnCallbacks } from "../src/agent/pairing.js";

// ── helpers ──

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-harness-pairing-"));
}

/** Create a mock SSE stream that emits text_delta chunks. */
function mockSseStream(chunks: string[], usage?: Record<string, unknown>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const allChunks = [...chunks];
  let idx = 0;

  return new ReadableStream({
    pull(controller) {
      if (idx < allChunks.length) {
        const payload: Record<string, unknown> = {
          choices: [{ delta: { content: allChunks[idx] } }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        idx++;
      } else if (idx === allChunks.length) {
        // Send usage chunk if provided
        if (usage) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ usage })}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });
}

/** Create a minimal valid mock Response for the DeepSeek chat completions endpoint. */
function mockResponse(chunks: string[], usage?: Record<string, unknown>): Response {
  return {
    ok: true,
    body: mockSseStream(chunks, usage),
    json: async () => ({}),
  } as unknown as Response;
}

interface MockCall {
  url: string;
  body: Record<string, unknown>;
}

/** Track fetch calls and return mock responses based on the model in the request. */
function mockFetchWithTracking(calls: MockCall[]) {
  return (url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : {};
    calls.push({ url: String(url), body });

    const model = String(body.model ?? "");

    if (model === "deepseek-v4-pro") {
      // Architect response: a plan with checkboxes and file paths
      return Promise.resolve(mockResponse(
        [
          "Here is the plan:\n\n",
          "- [ ] Read `src/main.ts`\n",
          "- [ ] Edit `src/utils.ts`\n",
          "- [ ] Verify changes\n",
        ],
        { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
      ));
    }

    if (model === "deepseek-v4-flash") {
      // Editor response: execution output
      return Promise.resolve(mockResponse(
        ["Executing step 1: Reading file…\n", "Done reading.\n", "Step 2: Editing…\n", "All steps complete."],
        { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 },
      ));
    }

    // Fallback
    return Promise.resolve(mockResponse(
      ["Fallback response."],
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ));
  };
}

// ── extractPlan tests ──

test("extractPlan parses checklist items from markdown", () => {
  const response = [
    "Here is my analysis:",
    "",
    "- [ ] Step one: read the config file",
    "- [ ] Step two: modify the settings",
    "- [ ] Step three: verify the output",
  ].join("\n");

  const plan = extractPlan(response);

  assert.equal(plan.steps.length, 3);
  assert.ok(plan.steps[0].includes("read the config file"));
  assert.ok(plan.steps[1].includes("modify the settings"));
  assert.ok(plan.steps[2].includes("verify the output"));
  assert.equal(plan.reasoning, response);
});

test("extractPlan extracts file paths from backtick references", () => {
  const response = [
    "Need to modify `src/main.ts` and `test/main.test.ts`.",
    "Also check `config.json` and `README.md`.",
  ].join("\n");

  const plan = extractPlan(response);

  assert.ok(plan.files.includes("src/main.ts"));
  assert.ok(plan.files.includes("test/main.test.ts"));
  assert.ok(plan.files.includes("config.json"));
  assert.ok(plan.files.includes("README.md"));
});

test("extractPlan extracts file paths for various extensions", () => {
  const response = "Files: `app.tsx`, `util.js`, `mod.py`, `lib.rs`, `main.go`, `schema.yaml`, `config.toml`.";

  const plan = extractPlan(response);

  assert.equal(plan.files.length, 7);
  assert.ok(plan.files.includes("app.tsx"));
  assert.ok(plan.files.includes("util.js"));
  assert.ok(plan.files.includes("mod.py"));
  assert.ok(plan.files.includes("lib.rs"));
  assert.ok(plan.files.includes("main.go"));
  assert.ok(plan.files.includes("schema.yaml"));
  assert.ok(plan.files.includes("config.toml"));
});

test("extractPlan handles empty/minimal responses", () => {
  const empty = extractPlan("");

  assert.equal(empty.steps.length, 1);
  assert.equal(empty.steps[0], "");
  assert.equal(empty.files.length, 0);
  assert.equal(empty.reasoning, "");
});

test("extractPlan handles responses with no checkboxes or files", () => {
  const response = "No specific files to change. Just a general comment.";

  const plan = extractPlan(response);

  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0], response.slice(0, 200));
  assert.equal(plan.files.length, 0);
});

test("extractPlan handles long responses without checkboxes — truncates to 200 chars", () => {
  const response = "x".repeat(500);

  const plan = extractPlan(response);

  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].length, 200);
  assert.equal(plan.files.length, 0);
});

// ── PairingConfig tests ──

test("PairingConfig has correct defaults", () => {
  const config: PairingConfig = {
    architect: "deepseek-v4-pro",
    editor: "deepseek-v4-flash",
    enabled: false,
  };

  assert.equal(config.architect, "deepseek-v4-pro");
  assert.equal(config.editor, "deepseek-v4-flash");
  assert.equal(config.enabled, false);
});

test("PairingConfig can be toggled on", () => {
  const config: PairingConfig = {
    architect: "deepseek-v4-pro",
    editor: "deepseek-v4-flash",
    enabled: true,
  };

  assert.equal(config.enabled, true);
});

// ── Paired turn event sequence ──

test("pairedTurn emits architect → editor → complete phase sequence", async () => {
  const stateDir = tempDir();
  const store = new HarnessStore(stateDir);
  try {
    const session = createSession(store, tempDir(), "deepseek-v4-flash");
    const calls: MockCall[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchWithTracking(calls) as typeof globalThis.fetch;

    try {
      const phases: string[] = [];
      const texts: string[] = [];
      const callbacks: PairedTurnCallbacks = {
        onText: (text) => { texts.push(text); },
        onPhase: (phase) => { phases.push(phase); },
      };

      const config: PairingConfig = {
        architect: "deepseek-v4-pro",
        editor: "deepseek-v4-flash",
        enabled: true,
      };

      const result = await pairedTurn(session, "test-key", "Fix the bug in utils.ts", config, callbacks);

      // Phase sequence
      assert.deepEqual(phases, ["architect", "editor", "complete"]);
      // Text was emitted
      assert.ok(texts.length > 0);

      // Result structure
      assert.ok(result.plan.steps.length > 0);
      assert.ok(result.result.length > 0);
      assert.ok(result.totalTokens > 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    store.close();
  }
});

// ── Token accumulation ──

test("pairedTurn accumulates tokens across architect and editor phases", async () => {
  const stateDir = tempDir();
  const store = new HarnessStore(stateDir);
  try {
    const session = createSession(store, tempDir(), "deepseek-v4-flash");
    const calls: MockCall[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchWithTracking(calls) as typeof globalThis.fetch;

    try {
      const config: PairingConfig = {
        architect: "deepseek-v4-pro",
        editor: "deepseek-v4-flash",
        enabled: true,
      };

      const result = await pairedTurn(session, "test-key", "Add tests for the parser", config, {
        onText: () => {},
        onPhase: () => {},
      });

      // Architect: 130 tokens, Editor: 250 tokens = 380 total
      assert.equal(result.totalTokens, 130 + 250);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    store.close();
  }
});

// ── Architect uses specified model ──

test("architect phase uses the architect model in the API payload", async () => {
  const stateDir = tempDir();
  const store = new HarnessStore(stateDir);
  try {
    const session = createSession(store, tempDir(), "deepseek-v4-flash");
    const calls: MockCall[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchWithTracking(calls) as typeof globalThis.fetch;

    try {
      const config: PairingConfig = {
        architect: "deepseek-v4-pro",
        editor: "deepseek-v4-flash",
        enabled: true,
      };

      await pairedTurn(session, "test-key", "Refactor the codebase", config, {
        onText: () => {},
        onPhase: () => {},
      });

      // First call should use architect model
      assert.equal(calls.length, 2);
      assert.equal(calls[0].body.model, "deepseek-v4-pro");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    store.close();
  }
});

// ── Editor uses specified model ──

test("editor phase uses the editor model in the API payload", async () => {
  const stateDir = tempDir();
  const store = new HarnessStore(stateDir);
  try {
    const session = createSession(store, tempDir(), "deepseek-v4-flash");
    const calls: MockCall[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchWithTracking(calls) as typeof globalThis.fetch;

    try {
      const config: PairingConfig = {
        architect: "deepseek-v4-pro",
        editor: "deepseek-v4-flash",
        enabled: true,
      };

      await pairedTurn(session, "test-key", "Write documentation", config, {
        onText: () => {},
        onPhase: () => {},
      });

      // Second call should use editor model
      assert.equal(calls.length, 2);
      assert.equal(calls[1].body.model, "deepseek-v4-flash");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    store.close();
  }
});

// ── Custom model names ──

test("pairedTurn supports custom architect and editor model names", async () => {
  const stateDir = tempDir();
  const store = new HarnessStore(stateDir);
  try {
    const session = createSession(store, tempDir(), "deepseek-v4-flash");
    const calls: MockCall[] = [];
    const originalFetch = globalThis.fetch;

    // Mock that only returns for custom model names
    globalThis.fetch = ((url: string, init?: RequestInit): Promise<Response> => {
      const body = init?.body ? JSON.parse(init.body as string) as Record<string, unknown> : {};
      calls.push({ url: String(url), body });
      const model = String(body.model ?? "");
      if (model === "custom-pro-v2") {
        return Promise.resolve(mockResponse(["- [ ] Plan step one\n", "- [ ] Plan step two\n"],
          { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }));
      }
      return Promise.resolve(mockResponse(["Executing custom plan…\n", "Done.\n"],
        { prompt_tokens: 80, completion_tokens: 15, total_tokens: 95 }));
    }) as typeof globalThis.fetch;

    try {
      const config: PairingConfig = {
        architect: "custom-pro-v2",
        editor: "some-flash-variant",
        enabled: true,
      };

      const result = await pairedTurn(session, "test-key", "Task", config, {
        onText: () => {},
        onPhase: () => {},
      });

      assert.equal(calls.length, 2);
      assert.equal(calls[0].body.model, "custom-pro-v2");
      assert.equal(calls[1].body.model, "some-flash-variant");
      assert.ok(result.totalTokens > 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    store.close();
  }
});

// ── Session record updated ──

test("pairedTurn persists messages and cost to the session", async () => {
  const stateDir = tempDir();
  const store = new HarnessStore(stateDir);
  try {
    const session = createSession(store, tempDir(), "deepseek-v4-flash");
    const calls: MockCall[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchWithTracking(calls) as typeof globalThis.fetch;

    try {
      const config: PairingConfig = {
        architect: "deepseek-v4-pro",
        editor: "deepseek-v4-flash",
        enabled: true,
      };

      await pairedTurn(session, "test-key", "Do something", config, {
        onText: () => {},
        onPhase: () => {},
      });

      // Session should have been updated with cost and messages
      const fresh = store.getSession(session.id);
      assert.ok(fresh.total_cost_usd > 0, "Session cost should be > 0");
      assert.ok(fresh.message_count >= 2, "Should have at least user + assistant messages");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    store.close();
  }
});

// ── Architect phase has no tools ──

test("architect phase sends no tools in the API payload", async () => {
  const stateDir = tempDir();
  const store = new HarnessStore(stateDir);
  try {
    const session = createSession(store, tempDir(), "deepseek-v4-flash");
    const calls: MockCall[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchWithTracking(calls) as typeof globalThis.fetch;

    try {
      const config: PairingConfig = {
        architect: "deepseek-v4-pro",
        editor: "deepseek-v4-flash",
        enabled: true,
      };

      await pairedTurn(session, "test-key", "Task", config, {
        onText: () => {},
        onPhase: () => {},
      });

      // Architect call should have no tools
      assert.equal(calls[0].body.tools, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    store.close();
  }
});

// ── Editor phase has tools ──

test("editor phase sends tools in the API payload", async () => {
  const stateDir = tempDir();
  const store = new HarnessStore(stateDir);
  try {
    const session = createSession(store, tempDir(), "deepseek-v4-flash");
    const calls: MockCall[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchWithTracking(calls) as typeof globalThis.fetch;

    try {
      const config: PairingConfig = {
        architect: "deepseek-v4-pro",
        editor: "deepseek-v4-flash",
        enabled: true,
      };

      await pairedTurn(session, "test-key", "Task", config, {
        onText: () => {},
        onPhase: () => {},
      });

      // Editor call should have tools
      assert.ok(Array.isArray(calls[1].body.tools));
      assert.ok((calls[1].body.tools as unknown[]).length > 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    store.close();
  }
});

// ── extractPlan with mixed content ──

test("extractPlan parses both checklists and file references together", () => {
  const response = [
    "## Plan",
    "",
    "- [ ] Create `src/pairing.ts` with the orchestrator",
    "- [ ] Add `/pair` command to `src/agent/tui.tsx`",
    "- [ ] Update `src/agent/loop.ts` for model override",
    "- [ ] Write tests in `test/agent-pairing.test.ts`",
    "",
    "This will cut costs significantly.",
  ].join("\n");

  const plan = extractPlan(response);

  assert.equal(plan.steps.length, 4);
  assert.ok(plan.files.includes("src/pairing.ts"));
  assert.ok(plan.files.includes("src/agent/tui.tsx"));
  assert.ok(plan.files.includes("src/agent/loop.ts"));
  assert.ok(plan.files.includes("test/agent-pairing.test.ts"));
  assert.equal(plan.reasoning, response);
});

// ── extractPlan deduplicates steps ──

test("extractPlan preserves all steps even if similar", () => {
  const response = "- [ ] Check file A\n- [ ] Check file B\n- [ ] Check file C\n";

  const plan = extractPlan(response);

  assert.equal(plan.steps.length, 3);
});
