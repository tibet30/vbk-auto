import { extractSensitiveWords } from "../../../../shared/sensitive-words.js";
import { describeVbkFailureDetail } from "../../../infrastructure/vbk-response-error.js";
import { PresentationSensitiveWordsError } from "./save-monitor.js";
import type { VbkSessionRequestResult } from "../../../infrastructure/vbk-session-request.js";

export class PresentationCopyRejectedError extends PresentationSensitiveWordsError {
  constructor(words: string[], status: number, public readonly source: string, detail: string) {
    super(words, status);
    this.message = detail;
  }
}

/** HTTP/权限故障不进入文案修复；只读取平台明确的词列表或非法词反馈。 */
export function assertNoPresentationRejectedWords(result: VbkSessionRequestResult, source: string): void {
  if (result.status < 200 || result.status >= 300) return;
  const payload = result.payload as Record<string, any> | null;
  if (!payload || typeof payload !== "object") return;
  const raw = payload.sensitiveWords ?? payload.SensitiveWords;
  const detail = describeVbkFailureDetail(payload);
  const words = [...new Set([
    ...(Array.isArray(raw) ? raw.filter((word): word is string => typeof word === "string").map(word => word.trim()).filter(Boolean) : []),
    ...extractSensitiveWords(detail),
  ])];
  if (!words.length) return;
  const ack = payload.ResponseStatus?.Ack;
  throw new PresentationCopyRejectedError(words, result.status, source,
    `产品图文触发敏感词：${source}${ack ? ` Ack=${ack}` : ""}：${detail || `非法关键词：${words.join("、")}`}`);
}
