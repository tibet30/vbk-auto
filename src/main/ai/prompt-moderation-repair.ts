/**
 * 模型输入审核（HTTP 422 / status_code 1026 input new_sensitive）的**自我修复**重试。
 *
 * 这类拒绝与网络、鉴权、限流无关：同一份 prompt 原样重发必然再次被拒，所以不能交给
 * 「再试一次」的通用重试，而要在重发前把请求本身改造成更保守的形态：
 *
 *   level 0  原样发送（正常路径，不做任何改造）；
 *   level 1  把黑名单中不能入模的敏感字面量换成类别措辞（redactPromptUnsafeCopyTerms）；
 *   level 2  再把整段「VBK 文案黑名单」替换成一句中性约束，只留本地门禁兜底。
 *
 * 只有判定为输入审核拒绝时才升级到下一级；其它错误（超时 / 鉴权 / 输出格式）立即抛出，
 * 避免把真实故障掩盖成「重试成功」。
 */
import { isModelInputModerationMessage } from "../../shared/ai-input-moderation.js";
import { logWarn } from "../../shared/log-timestamp.js";
import { buildVbkCopyPolicyPrompt, redactPromptUnsafeCopyTerms } from "../planning/vbk-copy-policy.js";

/** 0=原样；1=字面量换类别；2=整段黑名单换成中性约束。 */
export type PromptRepairLevel = 0 | 1 | 2;

const MAX_REPAIR_LEVEL: PromptRepairLevel = 2;

/** 去掉整段黑名单后给模型的最小约束：本地门禁仍按平台真实驳回结果兜底。 */
const SAFE_COPY_POLICY_LINE =
  "VBK 文案限制：避免绝对化宣传（最、第一、唯一、顶级等）、政治人物姓名与宗教宣传式表述；"
  + "官方 POI 身份字段 poiName、requestedName 与原始路线 spots[].name 必须原样保留。"
  + "本地门禁会按平台实际驳回结果兜底，不必猜测具体禁用词。";

let copyPolicyBlock: string | undefined;
function copyPolicyText(): string {
  copyPolicyBlock ??= buildVbkCopyPolicyPrompt();
  return copyPolicyBlock;
}

/** 单条文本按修复等级做改造；level 0 原样返回。 */
export function sanitisePromptText(text: string, level: PromptRepairLevel): string {
  if (!text || level === 0) return text;
  const redacted = redactPromptUnsafeCopyTerms(text);
  if (level === 1) return redacted;
  const block = copyPolicyText();
  // 空串 split 会把文本拆成单字符并在字符间插入约束，产出畸形 prompt。
  if (!block) return redacted;
  // 同时匹配原文与脱敏后的整段黑名单：将来若新增未标 aiTerm 的词，脱敏后段落仍能整段移除。
  return redacted
    .split(block).join(SAFE_COPY_POLICY_LINE)
    .split(redactPromptUnsafeCopyTerms(block)).join(SAFE_COPY_POLICY_LINE);
}

export interface PromptMessageLike {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

/** 按修复等级改造整组 messages；数组型 content 只改 text part。 */
export function sanitisePromptMessages<T extends PromptMessageLike>(
  messages: readonly T[],
  level: PromptRepairLevel,
): T[] {
  if (level === 0) return [...messages];
  return messages.map((message) => {
    const content = message.content;
    if (typeof content === "string") return { ...message, content: sanitisePromptText(content, level) };
    if (Array.isArray(content)) {
      return {
        ...message,
        content: content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? { ...(part as Record<string, unknown>), text: sanitisePromptText((part as { text: string }).text, level) }
          : part)),
      };
    }
    return message;
  });
}

/** 输入审核拒绝：包括归一化前的 SDK 错误与归一化后的 PlannerError / MiniMaxServiceError。 */
export function isInputModerationFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "provider_input_moderated" || code === "input_moderated") return true;
  return isModelInputModerationMessage(error);
}

/**
 * 依次用 level 0/1/2 的 messages 调用 `call`；只有输入审核拒绝才升级修复等级。
 *
 * `buildMessages` 与 `call` 都必须是无副作用的纯调用：外部记账、事件写入放在 `call` 内部，
 * 重试时会按实际发出的请求重新记录。
 */
export async function attemptWithPromptRepair<T>(args: {
  label: string;
  buildMessages: (level: PromptRepairLevel) => PromptMessageLike[];
  call: (messages: PromptMessageLike[], level: PromptRepairLevel) => Promise<T>;
}): Promise<T> {
  let lastError: unknown;
  let previousSignature: string | undefined;
  for (let level: PromptRepairLevel = 0; level <= MAX_REPAIR_LEVEL; level = (level + 1) as PromptRepairLevel) {
    const messages = args.buildMessages(level);
    const signature = JSON.stringify(messages);
    // 不含黑名单段落的 prompt 在 level 1/2 改造后可能完全相同：同一份请求再发一次
    // 只会再被拒，直接跳到更保守的级别，避免白跑一次模型调用。
    if (level > 0 && signature === previousSignature) {
      if (level === MAX_REPAIR_LEVEL) throw lastError;
      continue;
    }
    previousSignature = signature;
    try {
      return await args.call(messages, level);
    } catch (error) {
      lastError = error;
      const moderation = isInputModerationFailure(error);
      if (!moderation || level === MAX_REPAIR_LEVEL) throw error;
      logWarn("[ai] input moderated, repairing prompt", {
        label: args.label,
        level,
        nextLevel: level + 1,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // 循环必然在最后一级 return 或 throw；这里只用于满足类型收窄。
  throw lastError instanceof Error ? lastError : new Error("模型输入审核修复未完成。");
}
