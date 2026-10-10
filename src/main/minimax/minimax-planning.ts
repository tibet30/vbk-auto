import type OpenAI from "openai";
import type { AiResponse } from "../../shared/contracts.js";
import { parseAssistantMessage } from "./minimax-parsing.js";

export const PLANNING_RETRY_LIMIT = 4;
const RETRY_INSTRUCTION = "上一次返回未通过结构化校验，请只返回纯 JSON 对象（仅包含 reply、patch、questions、researchTasks 四个字段），并为该轮返回至少一个可写入的 patch；不得带说明文字。";

export interface PlanningReplyClassification {
  fallback: boolean;
  trivial: boolean;
}

/** Keep placeholder/transport-noise classification independent from reply orchestration. */
export function classifyAssistantReply(reply: unknown): PlanningReplyClassification {
  if (typeof reply !== "string") return { fallback: false, trivial: false };
  const value = reply.trim();
  return {
    fallback: /^未获取到/.test(value)
      || /请重试|等待.*重试|持续.*说明|先记要点|下一条回复|带上完整结构化|当前先记/.test(value)
      || /不落盘|暂不落盘|暂不写入|先不写入|先不落盘|还需调整|还需补充|先回避|后补齐|仍无可写字段|暂无可写|先回传/.test(value)
      || /字段类型|类型错误|应重试|重试修正/.test(value)
      || /structured response rejected|Unexpected end of JSON|Unexpected token|响应格式|返回的数据格式/.test(value),
    trivial: /^(?:heartbeat|ok|done|ack|ping|received|好的|收到|ok!|yes)\.?$/i.test(value),
  };
}

export function buildPlanningMessages(input: {
  product: Record<string, unknown>;
  message: string;
  history: Array<{ role: string; content: string }>;
  systemPrompt: string;
  hasExistingDraft: boolean;
  attempt: number;
  lastRetryReason: string;
}): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const prompt = `当前产品草稿：${JSON.stringify(input.product)}\n\n用户本轮输入：${input.message}`;
  return [
    { role: "system", content: input.systemPrompt },
    ...(input.hasExistingDraft ? input.history.slice(-12) : []).map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: item.content,
    } as OpenAI.Chat.Completions.ChatCompletionMessageParam)),
    { role: "user", content: input.attempt === 0
      ? `${prompt}\n\n请通过 submit_product_update 工具返回结构化结果。`
      : `${prompt}\n\n${RETRY_INSTRUCTION}${input.lastRetryReason ? `\n\n上一次返回原因：${input.lastRetryReason}` : ""}` },
  ];
}

export function parsePlanningResponse(message: OpenAI.Chat.Completions.ChatCompletionMessage): {
  response: AiResponse;
  isStructured: boolean;
  classification: PlanningReplyClassification;
} {
  const parsed = parseAssistantMessage(message);
  return { ...parsed, classification: classifyAssistantReply(parsed.response.reply) };
}

export function decideRetry(code: string, attempt: number): boolean {
  return (code === "invalid_model_output" || code === "empty_model_output") && attempt < PLANNING_RETRY_LIMIT;
}
