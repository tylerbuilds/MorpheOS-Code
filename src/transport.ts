import crypto from "node:crypto";
import type { RunItem, RunManifest } from "./schema.js";

export interface CompletionResult {
  content: string;
  raw: unknown;
  usage: unknown;
}

export interface CompletionTransport {
  complete(manifest: RunManifest, item: RunItem): Promise<CompletionResult>;
}

function itemMessages(item: RunItem): { role: string; content: string }[] {
  if (item.messages) {
    return item.messages;
  }
  return [{ role: "user", content: item.prompt ?? "" }];
}

export class FakeTransport implements CompletionTransport {
  async complete(manifest: RunManifest, item: RunItem): Promise<CompletionResult> {
    const hash = crypto.createHash("sha256").update(JSON.stringify({ project: manifest.project, item })).digest("hex");
    const content =
      manifest.response_format === "json_object"
        ? JSON.stringify({ item_id: item.id, fake: true, digest: hash.slice(0, 12) })
        : `fake:${item.id}:${hash.slice(0, 12)}`;

    return {
      content,
      raw: { fake: true, item_id: item.id, digest: hash },
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, estimated_cost_usd: 0 }
    };
  }
}

export class DeepSeekDryRunTransport implements CompletionTransport {
  async complete(manifest: RunManifest, item: RunItem): Promise<CompletionResult> {
    const request = buildDeepSeekRequest(manifest, item);
    return {
      content: JSON.stringify({ dry_run: true, request }, null, 2),
      raw: { dry_run: true, request },
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, estimated_cost_usd: 0 }
    };
  }
}

export class DeepSeekLiveTransport implements CompletionTransport {
  readonly apiKey: string;
  readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://api.deepseek.com") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async complete(manifest: RunManifest, item: RunItem): Promise<CompletionResult> {
    const request = buildDeepSeekRequest(manifest, item);
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(request)
    });

    const raw = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      throw new Error(`DeepSeek API error ${response.status}: ${JSON.stringify(raw)}`);
    }

    const choices = raw?.choices as Array<{ message?: { content?: string } }> | undefined;
    const content = choices?.[0]?.message?.content ?? "";
    return {
      content,
      raw,
      usage: raw?.usage ?? null
    };
  }
}

export function buildDeepSeekRequest(manifest: RunManifest, item: RunItem): Record<string, unknown> {
  const request: Record<string, unknown> = {
    model: manifest.model,
    messages: itemMessages(item),
    thinking: manifest.thinking,
    stream: false,
    response_format: { type: manifest.response_format }
  };

  if (manifest.thinking.reasoning_effort) {
    request.reasoning_effort = manifest.thinking.reasoning_effort;
  }
  if (manifest.temperature !== undefined) {
    request.temperature = manifest.temperature;
  }
  if (manifest.max_tokens !== undefined) {
    request.max_tokens = manifest.max_tokens;
  }

  return request;
}
