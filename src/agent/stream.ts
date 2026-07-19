// src/agent/stream.ts

import { HarnessError } from "../errors.js";

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
    throw new HarnessError(
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
          // Skip malformed SSE lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const resultToolCalls = Array.from(toolCallMap.values()).map((tc) => ({
    id: tc.id,
    type: "function" as const,
    function: { name: tc.name, arguments: tc.args },
  }));

  return { text: fullText, toolCalls: resultToolCalls, usage };
}

export function getApiKey(): string {
  return process.env.DEEPSEEK_API_KEY ?? "";
}
