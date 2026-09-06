/** Providers sometimes put reasoning tags in ordinary content. Keep only the public answer. */
const THINK_BLOCK = /<think\b[^>]*>([\s\S]*?)(?:<\/think\s*>|$)/i;

export function stripAgentReasoning(content: string): string {
  return content.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think\s*>|$)/gi, "").trim();
}

export function splitAgentReasoning(content: string): {
  reasoning: string;
  answer: string;
  reasoningComplete: boolean;
} {
  const match = content.match(THINK_BLOCK);
  if (!match) {
    return { reasoning: "", answer: content.trim(), reasoningComplete: true };
  }
  const reasoningComplete = /<\/think\s*>/i.test(match[0]);
  const reasoning = (match[1] ?? "").trim();
  const answer = content.replace(match[0], "").trim();
  return { reasoning, answer, reasoningComplete };
}

export function shouldExpandAgentReasoning(input: {
  streaming?: boolean;
  reasoningComplete: boolean;
}): boolean {
  return !input.reasoningComplete;
}
