// Architect/Editor model pairing for MorpheOS Code
// Strong model (Pro) plans, cheap model (Flash) executes

import type { AgentSession } from "./session.js";
import { addAssistantMessage, addUserMessage, updateSessionCost } from "./session.js";
import { consumeStream } from "./stream.js";
import { createToolRegistry } from "./tools.js";

export interface PairingConfig {
  architect: string;   // e.g. "deepseek-v4-pro"
  editor: string;      // e.g. "deepseek-v4-flash"
  enabled: boolean;
}

export interface ArchitectPlan {
  steps: string[];
  files: string[];
  reasoning: string;
}

export interface PairedTurnCallbacks {
  onText: (text: string) => void;
  onPhase: (phase: string, text: string) => void;
}

// Pricing per 1M tokens (USD)
const MODEL_RATES: Record<string, { cacheHit: number; cacheMiss: number; output: number }> = {
  "deepseek-v4-pro": { cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87 },
  "deepseek-v4-flash": { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 },
};

function estimateCost(model: string, usage: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number } | null): number {
  if (!usage) return 0;
  const rates = MODEL_RATES[model] ?? MODEL_RATES["deepseek-v4-flash"];
  const cacheHitTokens = usage.prompt_cache_hit_tokens ?? 0;
  const cacheMissTokens = usage.prompt_cache_miss_tokens
    ?? Math.max(0, usage.prompt_tokens - cacheHitTokens);
  return (
    cacheHitTokens * rates.cacheHit
    + cacheMissTokens * rates.cacheMiss
    + usage.completion_tokens * rates.output
  ) / 1_000_000;
}

// Extract a structured plan from the architect's response
export function extractPlan(response: string): ArchitectPlan {
  const steps: string[] = [];
  const files: string[] = [];
  
  // Parse markdown checklist items: "- [ ] do something"
  const stepMatch = response.match(/- \[ \].*/g);
  if (stepMatch) steps.push(...stepMatch.map(s => s.replace("- [ ] ", "").trim()));
  
  // Extract file paths from backtick references
  const fileMatch = response.match(/`([^`]+\.(ts|js|py|rs|go|md|json|yaml|yml|toml|tsx|jsx))`/g);
  if (fileMatch) files.push(...fileMatch.map(f => f.replace(/`/g, "")));

  return {
    steps: steps.length > 0 ? steps : [response.slice(0, 200)],
    files,
    reasoning: response,
  };
}

const ARCHITECT_SYSTEM_PROMPT = `You are the Architect. Analyse the task and produce a clear, step-by-step plan. List each step as a checkbox. Mention specific files that need changes. Do NOT execute any tools — only plan.`;

const EDITOR_SYSTEM_PROMPT = `You are the Editor. Execute the provided plan precisely using the available tools. Report progress after each step.`;

// Run architect → editor pipeline
export async function pairedTurn(
  session: AgentSession,
  apiKey: string,
  userInput: string,
  config: PairingConfig,
  callbacks: PairedTurnCallbacks,
): Promise<{ plan: ArchitectPlan; result: string; totalTokens: number }> {
  const registry = createToolRegistry();
  let totalTokens = 0;

  // Phase 1: Architect (Pro) plans
  callbacks.onPhase("architect", "Architect planning...");
  
  const planMessages = [
    { role: "system" as const, content: ARCHITECT_SYSTEM_PROMPT },
    { role: "user" as const, content: userInput },
  ];

  let planText = "";
  const planResult = await consumeStream(apiKey, planMessages, [], config.architect, {
    onText: (text) => { planText += text; callbacks.onText(text); },
  });
  totalTokens += planResult.usage?.total_tokens ?? 0;

  const plan = extractPlan(planText);

  // Phase 2: Editor (Flash) executes
  callbacks.onPhase("editor", "\nEditor executing...");

  const editorPrompt = `Execute the following plan step by step using the available tools:

## Plan
${plan.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

## Context
Original request: ${userInput}

Work through each step. Use tools to read files, make edits, and verify changes.`;

  const editorMessages = [
    { role: "system" as const, content: EDITOR_SYSTEM_PROMPT },
    { role: "user" as const, content: editorPrompt },
  ];

  let editorText = "";
  const editorResult = await consumeStream(apiKey, editorMessages, registry.describe(), config.editor, {
    onText: (text) => { editorText += text; callbacks.onText(text); },
  });
  totalTokens += editorResult.usage?.total_tokens ?? 0;

  // Persist messages and cost to the session
  addUserMessage(session, userInput);
  addAssistantMessage(session, editorText, null, editorResult.usage?.total_tokens ?? null, null);
  updateSessionCost(session, estimateCost(config.architect, planResult.usage));
  updateSessionCost(session, estimateCost(config.editor, editorResult.usage));

  callbacks.onPhase("complete", "\nDone.");

  return { plan, result: editorText, totalTokens };
}
