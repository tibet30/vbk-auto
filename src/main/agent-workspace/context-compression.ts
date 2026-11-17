import type {
  AgentThreadContext,
  AgentThreadMessage,
  AgentThreadSummary,
} from "../../shared/contracts-agent-workspace.js";

const DEFAULT_RECENT_MESSAGES = 24;
const DEFAULT_TOKEN_BUDGET = 8_000;
const SUMMARY_ITEM_LIMIT = 18;
const SUMMARY_ITEM_CHARS = 180;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 2));
}

function summaryLine(message: AgentThreadMessage): string {
  const label = message.role === "user" ? "用户" : message.role === "assistant" ? "智能体" : "系统";
  const singleLine = message.content.replace(/\s+/gu, " ").trim();
  const excerpt = singleLine.length > SUMMARY_ITEM_CHARS
    ? `${singleLine.slice(0, SUMMARY_ITEM_CHARS)}…`
    : singleLine;
  return `- ${label}：${excerpt}`;
}

export function buildThreadSummary(
  messages: AgentThreadMessage[],
  previous?: AgentThreadSummary,
  now = new Date().toISOString(),
): AgentThreadSummary | undefined {
  const covered = Math.max(0, messages.length - DEFAULT_RECENT_MESSAGES);
  if (!covered) return previous;
  const older = messages.slice(Math.max(0, covered - SUMMARY_ITEM_LIMIT), covered);
  const omitted = Math.max(0, covered - older.length);
  const text = [
    omitted ? `较早的 ${omitted} 条记录已保留在完整历史中。` : "",
    ...older.map(summaryLine),
  ].filter(Boolean).join("\n");
  if (previous?.coveredMessageCount === covered && previous.text === text) return previous;
  return {
    revision: (previous?.revision ?? 0) + 1,
    coveredMessageCount: covered,
    text,
    updatedAt: now,
  };
}

export function assembleThreadContext(input: {
  messages: AgentThreadMessage[];
  summary?: AgentThreadSummary;
  recentMessageLimit?: number;
  tokenBudget?: number;
}): AgentThreadContext {
  const recentLimit = Math.max(4, input.recentMessageLimit ?? DEFAULT_RECENT_MESSAGES);
  const tokenBudget = Math.max(1_000, input.tokenBudget ?? DEFAULT_TOKEN_BUDGET);
  const recent = input.messages.slice(-recentLimit);
  const selected: AgentThreadContext["messages"] = [];
  let used = input.summary ? estimateTokens(input.summary.text) : 0;

  for (const message of recent.reverse()) {
    const cost = estimateTokens(message.content);
    if (selected.length >= 4 && used + cost > tokenBudget) break;
    selected.unshift({ role: message.role, content: message.content });
    used += cost;
  }

  return {
    messages: selected,
    ...(input.summary ? { summary: input.summary } : {}),
    compressedMessageCount: Math.max(0, input.messages.length - selected.length),
    estimatedTokens: used,
  };
}

