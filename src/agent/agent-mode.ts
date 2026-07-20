// MorpheOS Code — Agent-native mode
// Machine-readable JSON output for AI agents driving the harness via CLI.
// Usage: morpheos --json "fix the auth bug" --session my-project

import { z } from "zod";
import { HarnessStore } from "../store.js";
import type { AgentEvent, TokenUsage } from "./events.js";
import { createSession, resumeSession, updateSessionSummary, type AgentSession } from "./session.js";
import { getApiKey } from "./stream.js";
import { agentTurn } from "./loop.js";
import { createToolRegistry } from "./tools.js";

export interface AgentTurnResult {
  ok: boolean;
  session_id: string;
  model: string;
  response: string | null;
  reasoning_content: string;
  tool_calls: AgentToolCallRecord[];
  usage: TokenUsage | null;
  cost_usd: number;
  session_cost_usd: number;
  session_tokens: number;
  error?: string;
}

export interface AgentToolCallRecord {
  name: string;
  params: Record<string, unknown>;
  result: string;
  summary: string;
  error?: string;
}

const STATE_DIR = process.env.DEEPSEEK_HARNESS_STATE_DIR ?? ".state";

function estimateCost(model: string, tokens: number): number {
  const ratePerMillion = model === "deepseek-v4-pro" ? 5.0 : 1.10;
  return (tokens / 1_000_000) * ratePerMillion;
}

export async function agentChat(options: {
  prompt: string;
  session?: string;
  model?: string;
}): Promise<AgentTurnResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      ok: false,
      session_id: "",
      model: options.model ?? "deepseek-v4-flash",
      response: null,
      reasoning_content: "",
      tool_calls: [],
      usage: null,
      cost_usd: 0,
      session_cost_usd: 0,
      session_tokens: 0,
      error: "DEEPSEEK_API_KEY not set. Agents should inject this via environment.",
    };
  }

  const store = new HarnessStore(STATE_DIR);
  let session: AgentSession | undefined;

  try {
    session = options.session
      ? resumeSession(store, options.session)
      : createSession(store, process.cwd(), options.model ?? "deepseek-v4-flash");

    // Override model if specified
    if (options.model) session.model = options.model;

    const registry = createToolRegistry();
    // Agents get full tool access — no interactive approval gating needed
    // since the agent is already authorised by the operator

    const toolCalls: AgentToolCallRecord[] = [];
    let fullText = "";
    let fullReasoning = "";
    let finalUsage: TokenUsage | null = null;
    // Use an object wrapper so the closure can mutate it
    const usageRef: { current: TokenUsage | null } = { current: null };

    const sink = (event: AgentEvent): void => {
      switch (event.type) {
        case "text_delta":
          fullText += event.delta;
          break;
        case "reasoning_delta":
          fullReasoning += event.delta;
          break;
        case "tool_start":
          toolCalls.push({
            name: event.name,
            params: event.params,
            result: "",
            summary: "running...",
          });
          break;
        case "tool_end": {
          const last = toolCalls[toolCalls.length - 1];
          if (last && last.name === event.name) {
            last.summary = event.summary;
            last.error = event.error;
          }
          break;
        }
        case "usage":
          usageRef.current = event.usage;
          break;
      }
    };

    await agentTurn(session, apiKey, options.prompt, sink, registry, {
      baseUrl: process.env.DEEPSEEK_API_BASE_URL,
    });

    // Update tool call results by reading stored messages
    const messages = session.store.getMessages(session.id);
    for (const tc of toolCalls) {
      const toolMsg = messages.find(m => m.role === "tool" && tc.name);
      if (toolMsg?.content) tc.result = toolMsg.content;
    }

    const tokens = usageRef.current?.total_tokens ?? 0;
    const cost = estimateCost(session.model, tokens);

    // Auto-summarise for session list
    if (session.record.message_count <= 5) {
      updateSessionSummary(session, options.prompt.slice(0, 80));
    }

    // Refresh session record for accurate cost
    const fresh = store.getSession(session.id);

    return {
      ok: true,
      session_id: session.id,
      model: session.model,
      response: fullText || null,
      reasoning_content: fullReasoning,
      tool_calls: toolCalls,
      usage: usageRef.current,
      cost_usd: cost,
      session_cost_usd: fresh.total_cost_usd,
      session_tokens: fresh.total_tokens,
    };
  } catch (error) {
    return {
      ok: false,
      session_id: session?.id ?? "",
      model: options.model ?? "deepseek-v4-flash",
      response: null,
      reasoning_content: "",
      tool_calls: [],
      usage: null,
      cost_usd: 0,
      session_cost_usd: 0,
      session_tokens: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    store.close();
  }
}

export const chatOutputSchema = {
  ok: z.boolean(),
  session_id: z.string(),
  model: z.string(),
  response: z.string().nullable(),
  reasoning_content: z.string(),
  tool_calls: z.array(z.object({
    name: z.string(),
    params: z.record(z.unknown()),
    result: z.string(),
    summary: z.string(),
    error: z.string().optional(),
  })),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number(),
  }).nullable(),
  cost_usd: z.number(),
  session_cost_usd: z.number(),
  session_tokens: z.number(),
  error: z.string().optional(),
};
