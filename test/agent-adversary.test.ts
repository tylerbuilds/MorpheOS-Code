// test/agent-adversary.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { reviewToolCall, DEFAULT_ADVERSARY_CONFIG, type AdversaryConfig } from "../src/agent/adversary.js";

// ── helpers ──

/** Create a minimal SSE stream that emits text_delta chunks from an array of strings. */
function mockSseStream(chunks: string[]): ReadableStream<Uint8Array> {
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
      } else {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });
}

/** Create a minimal valid mock Response for the DeepSeek chat completions endpoint. */
function mockResponse(chunks: string[]): Response {
  return {
    ok: true,
    body: mockSseStream(chunks),
    json: async () => ({}),
  } as unknown as Response;
}

/** Setup: mock global fetch and DEEPSEEK_API_KEY. Returns restore function. */
function setupMockFetch(reviewTextChunks: string[]): () => void {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";

  globalThis.fetch = ((_url: string, _init?: RequestInit): Promise<Response> => {
    return Promise.resolve(mockResponse(reviewTextChunks));
  }) as typeof globalThis.fetch;

  return () => {
    globalThis.fetch = originalFetch;
    if (originalApiKey !== undefined) {
      process.env.DEEPSEEK_API_KEY = originalApiKey;
    } else {
      delete process.env.DEEPSEEK_API_KEY;
    }
  };
}

const enabledConfig: AdversaryConfig = {
  enabled: true,
  policies: ["Never delete files outside src/"],
  model: "deepseek-v4-flash",
};

// ── tests ──

test("disabled adversary allows all calls", async () => {
  const restore = setupMockFetch(["VERDICT: BLOCK\nREASONING: should not be called\n"]);
  try {
    const verdict = await reviewToolCall(
      { ...DEFAULT_ADVERSARY_CONFIG, policies: ["Never delete files"] },
      "delete_file",
      { file_path: "/tmp/test.txt" },
    );
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.reasoning, "Adversary mode disabled");
  } finally {
    restore();
  }
});

test("empty policies allows all calls", async () => {
  const restore = setupMockFetch(["VERDICT: BLOCK\nREASONING: should not be called\n"]);
  try {
    const verdict = await reviewToolCall(
      { enabled: true, policies: [], model: "deepseek-v4-flash" },
      "delete_file",
      { file_path: "/tmp/test.txt" },
    );
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.reasoning, "Adversary mode disabled");
  } finally {
    restore();
  }
});

test("policy matching: blocks delete_file with 'never delete files' policy", async () => {
  const restore = setupMockFetch([
    "VERDICT: BLOCK\n",
    "REASONING: The delete_file tool call would delete a file, violating the policy.\n",
    "POLICY: Never delete files outside src/\n",
  ]);
  try {
    const verdict = await reviewToolCall(
      enabledConfig,
      "delete_file",
      { file_path: "/Users/tyler/project/test.txt" },
    );
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.reasoning.includes("delete_file"));
    assert.equal(verdict.policyViolated, "Never delete files outside src/");
  } finally {
    restore();
  }
});

test("policy matching: blocks git push to main", async () => {
  const config: AdversaryConfig = {
    enabled: true,
    policies: ["Never push to main branch", "Always require code review"],
    model: "deepseek-v4-flash",
  };
  const restore = setupMockFetch([
    "VERDICT: BLOCK\n",
    "REASONING: The run_command would push to main, violating the 'Never push to main branch' policy.\n",
    "POLICY: Never push to main branch\n",
  ]);
  try {
    const verdict = await reviewToolCall(
      config,
      "run_command",
      { command: "git push origin main" },
    );
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.reasoning.includes("main"));
    assert.equal(verdict.policyViolated, "Never push to main branch");
  } finally {
    restore();
  }
});

test("non-matching policy allows safe tools", async () => {
  const config: AdversaryConfig = {
    enabled: true,
    policies: ["Never delete files outside src/"],
    model: "deepseek-v4-flash",
  };

  // read_file should be safe
  const restore1 = setupMockFetch([
    "VERDICT: ALLOW\n",
    "REASONING: The read_file tool does not delete any file, so it does not violate the policy.\n",
  ]);
  try {
    const verdict = await reviewToolCall(config, "read_file", { file_path: "/tmp/test.txt" });
    assert.equal(verdict.allowed, true);
    assert.ok(verdict.reasoning.includes("does not"));
  } finally {
    restore1();
  }

  // search_content should be safe
  const restore2 = setupMockFetch([
    "VERDICT: ALLOW\n",
    "REASONING: Searching content is a read-only operation that does not violate any policy.\n",
  ]);
  try {
    const verdict = await reviewToolCall(config, "search_content", { pattern: "test" });
    assert.equal(verdict.allowed, true);
  } finally {
    restore2();
  }
});

test("multiple policies — first violation blocks", async () => {
  const config: AdversaryConfig = {
    enabled: true,
    policies: [
      "Never delete files",
      "Never run destructive commands",
      "Never modify production configs",
    ],
    model: "deepseek-v4-flash",
  };
  const restore = setupMockFetch([
    "VERDICT: BLOCK\n",
    "REASONING: Deleting a file violates the first policy.\n",
    "POLICY: Never delete files\n",
  ]);
  try {
    const verdict = await reviewToolCall(
      config,
      "delete_file",
      { file_path: "/etc/config.json" },
    );
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.policyViolated, "Never delete files");
  } finally {
    restore();
  }
});

test("fail-open on API error", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";

  globalThis.fetch = (() => {
    return Promise.reject(new Error("Network error"));
  }) as typeof globalThis.fetch;

  try {
    const verdict = await reviewToolCall(
      enabledConfig,
      "delete_file",
      { file_path: "/tmp/test.txt" },
    );
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.reasoning, "Adversary review failed (API error)");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey !== undefined) {
      process.env.DEEPSEEK_API_KEY = originalApiKey;
    } else {
      delete process.env.DEEPSEEK_API_KEY;
    }
  }
});

test("fail-open when no API key is set", async () => {
  const originalApiKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;

  try {
    const verdict = await reviewToolCall(
      enabledConfig,
      "delete_file",
      { file_path: "/tmp/test.txt" },
    );
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.reasoning, "Adversary unavailable (no API key)");
  } finally {
    if (originalApiKey !== undefined) {
      process.env.DEEPSEEK_API_KEY = originalApiKey;
    }
  }
});

test("VERDICT parsing: ALLOW", async () => {
  const restore = setupMockFetch([
    "VERDICT: ALLOW\n",
    "REASONING: Safe operation, no policy violation.\n",
  ]);
  try {
    const verdict = await reviewToolCall(enabledConfig, "read_file", { file_path: "/tmp/test.txt" });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.reasoning, "Safe operation, no policy violation.");
    assert.equal(verdict.policyViolated, undefined);
  } finally {
    restore();
  }
});

test("VERDICT parsing: BLOCK", async () => {
  const restore = setupMockFetch([
    "VERDICT: BLOCK\n",
    "REASONING: The operation would delete a critical file.\n",
    "POLICY: Never delete files outside src/\n",
  ]);
  try {
    const verdict = await reviewToolCall(enabledConfig, "delete_file", { file_path: "/etc/hosts" });
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.reasoning.includes("critical file"));
    assert.equal(verdict.policyViolated, "Never delete files outside src/");
  } finally {
    restore();
  }
});

test("VERDICT parsing: malformed response falls back to first 100 chars", async () => {
  const restore = setupMockFetch(["This is some random text without any proper format."]);
  try {
    const verdict = await reviewToolCall(enabledConfig, "write_file", { file_path: "/tmp/test.txt", content: "hello" });
    // No VERDICT match — defaults to allowed=true
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.reasoning, "This is some random text without any proper format.");
  } finally {
    restore();
  }
});

test("REASONING extraction", async () => {
  const restore = setupMockFetch([
    "VERDICT: ALLOW\n",
    "REASONING: The tool call is a benign read operation that poses no risk.\n",
  ]);
  try {
    const verdict = await reviewToolCall(enabledConfig, "read_file", { file_path: "/tmp/test.txt" });
    assert.equal(verdict.reasoning, "The tool call is a benign read operation that poses no risk.");
  } finally {
    restore();
  }
});

test("POLICY extraction on BLOCK", async () => {
  const restore = setupMockFetch([
    "VERDICT: BLOCK\n",
    "REASONING: Violates the file deletion policy.\n",
    "POLICY: Never delete files outside src/\n",
  ]);
  try {
    const verdict = await reviewToolCall(enabledConfig, "delete_file", { file_path: "/tmp/test.txt" });
    assert.equal(verdict.policyViolated, "Never delete files outside src/");
  } finally {
    restore();
  }
});

test("no POLICY field on ALLOW", async () => {
  const restore = setupMockFetch([
    "VERDICT: ALLOW\n",
    "REASONING: No policy violation detected.\n",
  ]);
  try {
    const verdict = await reviewToolCall(enabledConfig, "read_file", { file_path: "/tmp/test.txt" });
    assert.equal(verdict.policyViolated, undefined);
  } finally {
    restore();
  }
});

test("default config is disabled with empty policies", () => {
  assert.equal(DEFAULT_ADVERSARY_CONFIG.enabled, false);
  assert.deepEqual(DEFAULT_ADVERSARY_CONFIG.policies, []);
  assert.equal(DEFAULT_ADVERSARY_CONFIG.model, "deepseek-v4-flash");
});

test("verdict parsing is case-insensitive for ALLOW", async () => {
  const restore = setupMockFetch([
    "VERDICT: allow\n",
    "REASONING: lowercase allow.\n",
  ]);
  try {
    const verdict = await reviewToolCall(enabledConfig, "read_file", { file_path: "/tmp/test.txt" });
    assert.equal(verdict.allowed, true);
  } finally {
    restore();
  }
});

test("verdict parsing is case-insensitive for BLOCK", async () => {
  const restore = setupMockFetch([
    "VERDICT: block\n",
    "REASONING: lowercase block.\n",
    "POLICY: test policy\n",
  ]);
  try {
    const verdict = await reviewToolCall(enabledConfig, "delete_file", { file_path: "/tmp/test.txt" });
    assert.equal(verdict.allowed, false);
  } finally {
    restore();
  }
});
