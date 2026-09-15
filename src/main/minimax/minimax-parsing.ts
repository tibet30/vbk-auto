/**
 * MiniMax / Evolink Chat Completions message → ParsedMinimaxResponse。
 */
import type OpenAI from "openai";
import { logWarn } from "../../shared/log-timestamp.js";
import { parseJson } from "./minimax-parsing-json.js";
import {
  extractBareReplyFromText,
  extractLooseReplyFromRaw,
  extractPlainReply,
  extractTextFallback,
  parseSparseResponse,
} from "./minimax-parsing-sparse.js";
import {
  pickBestStructuredResponse,
  unstructured,
  unstructuredFallbackReply,
  type ParsedMinimaxResponse,
} from "./minimax-parsing-types.js";

export function parseAssistantMessage(message: OpenAI.Chat.Completions.ChatCompletionMessage): ParsedMinimaxResponse {
  const allToolCalls = message.tool_calls?.filter((call): call is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
    call.type === "function" && typeof call.function.arguments === "string",
  );
  const toolCalls = allToolCalls?.filter((call) => call.function.name === "submit_product_update");
  if (toolCalls?.length) {
    let fallbackRaw = "";
    const structuredToolCalls: ParsedMinimaxResponse[] = [];
    for (const toolCall of toolCalls) {
      fallbackRaw += `${toolCall.function.arguments}\n`;
      const parsed = parseJson(toolCall.function.arguments);
      if (parsed.isStructured) structuredToolCalls.push(parsed);
    }
    // 当所有官方 tool_calls arguments 都是纯文本（无结构化字段），且 patch/questions/researchTasks 都空，
    // 拼接它们作为 fallback reply。
    const allEmptyStructured = toolCalls.length > 1
      && structuredToolCalls.every((c) =>
        (c.response.patch?.length ?? 0) === 0
        && (c.response.questions?.length ?? 0) === 0
        && (c.response.researchTasks?.length ?? 0) === 0);
    if (allEmptyStructured) {
      const joined = structuredToolCalls.map((c) => c.response.reply).filter(Boolean).join("\n");
      if (joined) return unstructured(joined);
    }
    const sparseFromTools = parseSparseResponse(fallbackRaw);
    let bestToolCall = pickBestStructuredResponse(structuredToolCalls);
    // 合并多 tool_call 的字段：bestToolCall 拿到 patch/qs/rt 最多的，
    // 但若它的 reply 是 missing 占位文本，则尝试从其它 tool_call 找非占位 reply 合并过来。
    if (bestToolCall && /^未获取到/.test(bestToolCall.response.reply ?? "")) {
      const nonFallback = structuredToolCalls.find((c) => c !== bestToolCall
        && typeof c.response.reply === "string"
        && c.response.reply.trim().length > 0
        && !/^未获取到/.test(c.response.reply));
      if (nonFallback) {
        bestToolCall = {
          response: { ...bestToolCall.response, reply: nonFallback.response.reply },
          isStructured: true,
        };
      }
    }
    // 当 sparseFromTools 拼接后的结构（patch/qs/rt 总数）比 bestToolCall 更完整时优先使用 sparseFromTools。
    if (sparseFromTools?.isStructured) {
      const sparseActions = (sparseFromTools.response.patch?.length ?? 0)
        + (sparseFromTools.response.questions?.length ?? 0)
        + (sparseFromTools.response.researchTasks?.length ?? 0);
      const bestActions = bestToolCall
        ? (bestToolCall.response.patch?.length ?? 0)
          + (bestToolCall.response.questions?.length ?? 0)
          + (bestToolCall.response.researchTasks?.length ?? 0)
        : 0;
      if (sparseActions > bestActions) return sparseFromTools;
    }
    if (sparseFromTools?.isStructured && !bestToolCall) {
      return sparseFromTools;
    }
    if (!message.content) {
      const fallbackFromRaw = extractTextFallback(fallbackRaw);
      const fallbackReply = fallbackFromRaw
        ?? extractLooseReplyFromRaw(fallbackRaw)
        ?? extractBareReplyFromText(fallbackRaw)
        ?? extractPlainReply(fallbackRaw)
        ?? extractTextFallback(fallbackRaw)
        ?? unstructuredFallbackReply;
      if (bestToolCall) {
        return bestToolCall;
      }
      return unstructured(fallbackReply);
    }
    const content = typeof message.content === "string" ? message.content : "";
    if (content.trim()) {
      const parsedFromContent = parseJson(content);
      const toolPatchCount = bestToolCall?.response.patch?.length ?? 0;
      const contentPatchCount = parsedFromContent.isStructured ? (parsedFromContent.response.patch?.length ?? 0) : 0;
      if (parsedFromContent.isStructured && (!bestToolCall || contentPatchCount > toolPatchCount)) {
        return parsedFromContent;
      }
      if (bestToolCall) {
        if (!parsedFromContent.isStructured && sparseFromTools) return sparseFromTools;
        return bestToolCall;
      }
      if (sparseFromTools) {
        return sparseFromTools;
      }
      return parsedFromContent;
    }
    if (sparseFromTools) {
      return sparseFromTools;
    }
    if (bestToolCall) return bestToolCall;
    logWarn("[AI] tool-call arguments rejected, fallback to message content", {
      attempts: toolCalls.length,
    });
  }
  // 当 tool_call 名字不是 submit_product_update（错位或拼错）时，只有 content 是噪音或不存在时，
  // 才回退用 tool_call arguments 解析；否则让上层 service 触发重试。
  const nonOfficialCalls = (message.tool_calls ?? []).filter((call): call is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
    call.type === "function"
    && typeof call.function.arguments === "string"
    && call.function.name !== "submit_product_update",
  );
  const rawContent = typeof message.content === "string" ? message.content : "";
  const contentIsNoise = /(?:^|\n)\s*(?:event:|data:|\[DONE\]|keep-alive)/.test(rawContent);
  const contentEmpty = !rawContent.trim();
  if (nonOfficialCalls.length && (contentIsNoise || contentEmpty)) {
    const combinedArgs = nonOfficialCalls.map((call) => call.function.arguments).join("\n");
    const typoParsed = parseJson(combinedArgs);
    if (typoParsed.isStructured) return typoParsed;
    const sparseFromTypo = parseSparseResponse(combinedArgs);
    if (sparseFromTypo) return sparseFromTypo;
  }
  const content = typeof message.content === "string" ? message.content : "";
  return parseJson(content);
}
