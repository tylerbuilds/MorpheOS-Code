export interface UsageEstimate {
  schema_version: "deepseek-harness.usage-estimate.v1";
  item_count: number;
  prompt_characters: number;
  estimated_prompt_tokens: number;
  max_completion_tokens_per_item: number | null;
  estimated_max_completion_tokens: number | null;
  estimated_max_total_tokens: number | null;
}

interface ManifestLike {
  max_tokens?: number;
  items: Array<{
    prompt?: string;
    messages?: Array<{ role: string; content: string }>;
    metadata?: Record<string, unknown>;
  }>;
}

export function estimateManifestUsage(manifest: ManifestLike): UsageEstimate {
  const promptCharacters = manifest.items.reduce((total, item) => total + itemCharacters(item), 0);
  const estimatedPromptTokens = Math.ceil(promptCharacters / 4);
  const maxCompletionTokens = manifest.max_tokens ?? null;
  const estimatedMaxCompletionTokens = maxCompletionTokens === null ? null : maxCompletionTokens * manifest.items.length;
  const estimatedMaxTotalTokens =
    estimatedMaxCompletionTokens === null ? null : estimatedPromptTokens + estimatedMaxCompletionTokens;

  return {
    schema_version: "deepseek-harness.usage-estimate.v1",
    item_count: manifest.items.length,
    prompt_characters: promptCharacters,
    estimated_prompt_tokens: estimatedPromptTokens,
    max_completion_tokens_per_item: maxCompletionTokens,
    estimated_max_completion_tokens: estimatedMaxCompletionTokens,
    estimated_max_total_tokens: estimatedMaxTotalTokens
  };
}

function itemCharacters(item: ManifestLike["items"][number]): number {
  const prompt = item.prompt ?? "";
  const messages = item.messages?.map((message) => `${message.role}:${message.content}`).join("\n") ?? "";
  const metadata = item.metadata ? JSON.stringify(item.metadata) : "";
  return prompt.length + messages.length + metadata.length;
}
