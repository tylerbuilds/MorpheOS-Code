// Adversary mode for MorpheOS Code
// Silent pre-execution reviewer that checks tool calls against natural-language policies

import { consumeStream, getApiKey } from "./stream.js";

export interface AdversaryConfig {
  enabled: boolean;
  policies: string[];          // Natural language policy statements
  model: string;               // Model to use for review (default: flash -- cheap and fast)
}

export interface AdversaryVerdict {
  allowed: boolean;
  reasoning: string;
  policyViolated?: string;
}

const REVIEW_PROMPT = `You are an adversary reviewer. Your job is to check whether a proposed tool call violates any of the user's safety policies.

## Policies
{policies}

## Proposed Tool Call
Tool: {toolName}
Parameters: {params}

## Instructions
1. Read each policy carefully.
2. Determine if the proposed tool call violates ANY policy.
3. If it violates a policy, respond with BLOCK and explain which policy.
4. If it does not violate any policy, respond with ALLOW.

Respond in this exact format:
VERDICT: ALLOW|BLOCK
REASONING: <one sentence>
POLICY: <the violated policy, only if BLOCK>`;

export async function reviewToolCall(
  config: AdversaryConfig,
  toolName: string,
  params: Record<string, unknown>,
): Promise<AdversaryVerdict> {
  if (!config.enabled || config.policies.length === 0) {
    return { allowed: true, reasoning: "Adversary mode disabled" };
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    // Fail open if no API key -- adversary is advisory, safety gate is the hard block
    return { allowed: true, reasoning: "Adversary unavailable (no API key)" };
  }

  const prompt = REVIEW_PROMPT
    .replace("{policies}", config.policies.map((p, i) => `${i + 1}. ${p}`).join("\n"))
    .replace("{toolName}", toolName)
    .replace("{params}", JSON.stringify(params, null, 2));

  const messages = [
    { role: "system" as const, content: prompt },
    { role: "user" as const, content: "Review the proposed tool call." },
  ];

  try {
    let reviewText = "";
    await consumeStream(apiKey, messages, [], config.model, {
      onText: (text) => { reviewText += text; },
    });

    const verdictMatch = reviewText.match(/VERDICT:\s*(ALLOW|BLOCK)/i);
    const reasoningMatch = reviewText.match(/REASONING:\s*(.+)/i);
    const policyMatch = reviewText.match(/POLICY:\s*(.+)/i);

    const allowed = verdictMatch?.[1]?.toUpperCase() !== "BLOCK";

    return {
      allowed,
      reasoning: reasoningMatch?.[1]?.trim() ?? reviewText.slice(0, 100),
      policyViolated: policyMatch?.[1]?.trim(),
    };
  } catch {
    // Fail open -- don't block work if the adversary can't reach the API
    return { allowed: true, reasoning: "Adversary review failed (API error)" };
  }
}

export const DEFAULT_ADVERSARY_CONFIG: AdversaryConfig = {
  enabled: false,
  policies: [],
  model: "deepseek-v4-flash",
};
