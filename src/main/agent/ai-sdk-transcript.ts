import type { ModelMessage } from "ai";
import type { AgentModelMessage } from "./types.js";

/**
 * AI SDK 要求每条 tool result 必须带 toolName，而核心 transcript 只保存 callId
 * （工具结果总是紧跟其调用组，见 core-transcript.ts）。这里一趟扫描建立映射即可，
 * 不改变历史顺序，也不伪造缺失结果。
 */
function toolNameIndex(messages: readonly AgentModelMessage[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) index.set(call.id, call.name);
  }
  return index;
}

/**
 * 把 provider-neutral 的 AgentModelMessage 转成 AI SDK 的 ModelMessage。
 *
 * 三条语义必须与 OpenAI 传输层一致：
 *  - 同一条 assistant 消息里的文本与全部 tool call 保持在同一个 content 数组；
 *  - 每条 assistant tool call 之后都有一条对应 tool result，顺序不动；
 *  - tool result 的正文以 text output 原样回放，不做 JSON 重编码。
 */
export function toModelMessages(messages: readonly AgentModelMessage[]): ModelMessage[] {
  const toolNames = toolNameIndex(messages);
  const converted: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      converted.push({ role: "system", content: message.content });
      continue;
    }
    if (message.role === "user") {
      converted.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role === "tool") {
      const toolCallId = message.toolCallId ?? "";
      converted.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId,
          toolName: toolNames.get(toolCallId) ?? "unknown",
          output: { type: "text", value: message.content },
        }],
      });
      continue;
    }
    if (!message.toolCalls?.length) {
      converted.push({ role: "assistant", content: message.content });
      continue;
    }
    converted.push({
      role: "assistant",
      content: [
        ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
        ...message.toolCalls.map((call) => ({
          type: "tool-call" as const,
          toolCallId: call.id,
          toolName: call.name,
          // 畸形参数不回放原始字符串：OpenAI 侧由 tool_result 的「参数 JSON 无效」反馈
          // 驱动模型修正，这里必须保持对象形态，否则整个请求会被供应商拒绝。
          input: call.arguments,
        })),
      ],
    });
  }
  return converted;
}
