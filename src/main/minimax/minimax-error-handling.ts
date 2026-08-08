
/**
 * MiniMax / Evolink 错误处理工具集：
 *   - 把任意 OpenAI 抛出的对象递归压缩成可读 reason 文本（extractMiniMaxFailureReason）；
 *   - 把错文案里的「请检查 / 重试」尾巴裁掉（stripRetryHintTail）；
 *   - 把 (code, reason) 翻译成项目内文案 + 归一化错误码（normalizeFailureMessage / classifyMiniMaxError）；
 *   - 配套给 UI / DevTools 看的 toRetryHint、isStructuredFormatFailure。
 */

export const normalizeWhitespace = (value: string) => value.replace(/[\s\u00a0\t\r\n]+/g, " ").trim();

const ignoreStructuralKeys = new Set(["code"]);

/**
 * 从错误文案中裁掉「请检查/重试」类尾部提示（中英文均覆盖），保留真正的故障原因。
 * 用于让 UI 上看到的错误信息只描述问题本身，不夹带模型 / 网关附带的重连建议。
 */
export function stripRetryHintTail(message: string) {
  let normalized = message.trim();
  const tailPatterns = [
    /\s*[，。；;,，\s]*(请(?:先)?(?:检查|确认|核实|确认|验证|校验|Check|check)[\s\S]{0,220}?(?:重试|再试|尝试|请求|再请求|retry|re-?try|attempt)[^!！;；,，\s]*)$/gui,
    /\s*[，。；;,，\s]*Please[\s\S]{0,140}?(?:retry|re-?try|attempt|request)[^!！;；,，\s]*$/gui,
  ];
  for (const pattern of tailPatterns) {
    const next = normalized.replace(pattern, "");
    normalized = next.trim();
  }
  normalized = normalized.replace(/[，。；;,，\s]+$/gu, "").trim();
  return normalized;
}

/**
 * 从 MiniMax（及其兼容代理）抛出的任意对象里递归提取可读的错误原因文本。
 * 按预定义顺序遍历常见字段（details / message / reason / error / cause / body / data / response…），
 * 找到第一个非空的字符串值后立即返回；用 WeakSet 防止循环引用。
 */
export function extractMiniMaxFailureReason(error: unknown, visited = new WeakSet<object>()): string {
  if (typeof error === "string") return normalizeWhitespace(error);
  if (!error || typeof error !== "object") return "";
  const entry = error as Record<string, unknown>;
  const seen = visited;
  if (seen.has(entry as object)) return "";
  seen.add(entry as object);

  const orderedKeys = ["details", "message", "reason", "error", "cause", "body", "data", "response", "statusText", "statusCode", "type", "name", "code"];
  for (const key of orderedKeys) {
    if (!(key in entry)) continue;
    if (ignoreStructuralKeys.has(key)) continue;
    const value = entry[key];
    const text = extractMiniMaxFailureReason(value, visited);
    if (text) return text;
  }
  for (const [key, value] of Object.entries(entry)) {
    if (ignoreStructuralKeys.has(key)) continue;
    const text = extractMiniMaxFailureReason(value, visited);
    if (text) return text;
  }
  if (Array.isArray(entry)) {
    for (const value of entry) {
      const text = extractMiniMaxFailureReason(value, visited);
      if (text) return text;
    }
  }
  return "";
}

/**
 * 把失败原因裁剪成「重试提示」：先做空白与尾部重试语句清洗，再按 maxLength 截断，
 * 截断后若为空则回退到「本轮结构化结果无法解析。」占位文案。
 */
export function toRetryHint(reason: string, maxLength = 180): string {
  const normalized = stripRetryHintTail(normalizeWhitespace(reason)).slice(0, maxLength);
  if (!normalized) return "本轮结构化结果无法解析。";
  return normalized;
}

/**
 * 判断字符串 reason 是否描述「结构化输出解析失败」（JSON 不合法、缺 fence、缺 token…）。
 * 用于在错误归类阶段把模型输出类失败与网关 / 网络类失败区分开。
 */
export function isStructuredFormatFailure(reason: string) {
  if (!reason) return false;
  if (/(?:structured response rejected|Unexpected end of JSON input|hasJsonFence|JSON.parse|Unexpected token|不是有效 JSON|不是合法 JSON|解析.*失败|响应格式|返回的数据格式)/i.test(reason)) return true;
  return false;
}

/**
 * 把任意 MiniMax 相关异常归一化为项目内部的 errorCode（invalid_model_output / empty_model_output /
 * provider_not_configured / provider_error 等），供 orchestrator 决定重试或回退到 needs_user。
 */
export function classifyMiniMaxError(error: unknown): string {
  const reason = extractMiniMaxFailureReason(error);
  if (reason && isStructuredFormatFailure(reason)) return "invalid_model_output";
  if (reason) {
    if (isStructuredFormatFailure(reason)
      || /(?:MiniMax|Evolink|AI)\s*(?:返回的数据格式无法用于产品方案|未返回可写入的产品方案|未返回可写入的结构化内容|未返回内容|未返回有效响应)|(?:未返回可写入的产品方案|返回的数据格式无法用于产品方案|empty_model_output)/i.test(reason)) {
      return "invalid_model_output";
    }
    if (/(?:json parse|not valid json|unexpected token|parse.*json|解析.*json|response.*json|invalid.*json)/i.test(reason)) {
      return "invalid_model_output";
    }
    if (/provider_not_configured/i.test(reason)) return "provider_not_configured";
  }
  if (error instanceof Error && "code" in error) {
    return (error as { code?: string }).code ?? "provider_error";
  }
  return (error as { code?: string })?.code ?? "provider_error";
}

/**
 * 把 (errorCode, 原 reason) 组合翻译成面向最终用户的失败说明：
 *   - 先去掉「请检查连接 / 配置后重试」类尾巴，避免重复噪音；
 *   - 不同 errorCode 走不同模板，例如 invalid_model_output 用「返回的数据格式无法用于产品方案」；
 *   - providerLabel 默认是 "MiniMax"，可被其他兼容代理（Evolink 等）覆盖。
 */
export function normalizeFailureMessage(errorCode: string, reason: string, providerLabel: string = "MiniMax"): string {
  const normalizedReason = reason && reason.trim() ? reason : "AI 服务暂时无法完成本次请求。";
  const stripTrailingRetryInstruction = (message: string) => stripRetryHintTail(message);

  const stripConnectionHint = (message: string) => {
    let normalized = message;
    const connectionPatterns = [
      /\s*请(?:先)?(?:检查|确认|核实)\s*(?:网络|连接|网络连接|配置|网路|联网|MiniMax\s*API|Evolink\s*API|AI\s*API|MiniMax|Evolink|AI)\s*(?:或(?:配置|网络|连接|鉴权|服务|API|token))?\s*(?:后|之后)?(?:可)?(?:重试|再试|重联|复试)[。!！]?\s*$/gu,
      /\s*请(?:先)?(?:检查|确认|核实)[^。!！]*?(?:后|之后)?(?:可)?(?:重试|再试|重联|复试)[。!！]?\s*$/gui,
      /\s*请先确认.*?后?\s*(?:可)?(?:重试|再试)[。!！]?/gui,
      /\s*[，。；;]请(?:先)?(?:检查|确认|核实|验证|校验)\s*(?:MiniMax(?:\s*API)?|Evolink(?:\s*API)?|AI(?:\s*API)?|网络|连接|网络连接|配置|网路|联网|服务|token)[^。!！;；,，]*(?:后|之后|之后再)?\s*(?:可)?\s*(?:重试|再试|再请求|复试|再次尝试|再次请求|尝试)[。!！;；,，]?\s*$/gui,
      /\s*[，。；;,，\s]*请(?:先)?(?:检查|确认|核实|验证|校验|检查并确认)[\s\S]{0,120}?(?:连接|配置|网络|API|MiniMax|Evolink|AI)[\s\S]{0,120}?(?:后|之后|之后再|再|再次)?(?:可)?(?:尝试|重试|再试|重试一下|重新发送|再次请求)[。!！;；,，\s]*$/gui,
      /\s*[，。；;,，\s]*Please\s+check[\s\S]{0,140}?(?:API|configuration|network|connection|token)[\s\S]{0,140}?(?:retry|re-?try|attempt|request)[。!！;；,，\s]*$/gui,
      /\s*[，。；;,，\s]*请(?:先)?(?:检查|确认|核实|验证|校验)[\s\S]{0,140}?(?:API|MiniMax|Evolink|AI|网络|连接|配置)[\s\S]{0,140}?(?:后再(?:次)?尝试|后重试|再尝试|再次请求)[。!！;；,，\s]*$/gui,
    ];
    for (const pattern of connectionPatterns) {
      normalized = normalized.replace(pattern, "");
    }
    return normalized.trim();
  };
  const normalizedForStructured = stripTrailingRetryInstruction(stripConnectionHint(normalizedReason));
  const isStructuredFailure = isStructuredFormatFailure(normalizedForStructured);

  if (errorCode === "invalid_model_output") {
    if (
      isStructuredFailure
      || /返回的数据格式无法用于产品方案|MiniMax 返回的数据格式无法用于产品方案|Evolink 返回的数据格式无法用于产品方案|AI 返回的数据格式无法用于产品方案|structured response rejected/i.test(normalizedForStructured)
    ) {
      return `${providerLabel} 返回的数据格式无法用于产品方案，请重试。`;
    }
    return `${providerLabel} 未返回可写入的产品方案，请重试。`;
  }
  if (errorCode === "empty_model_output") {
    return `${providerLabel} 未返回可写入的产品方案，请重试。`;
  }

  if (!(errorCode === "invalid_model_output" || errorCode === "empty_model_output") && !isStructuredFormatFailure(normalizedReason)) {
    return `${normalizedReason} 请检查连接或配置后重试。`;
  }
  if (/(?:返回的数据格式无法用于产品方案|structured response rejected|MiniMax 返回的数据格式无法用于产品方案|Evolink 返回的数据格式无法用于产品方案|AI 返回的数据格式无法用于产品方案)/i.test(normalizedReason)) {
    return `${providerLabel} 返回的数据格式无法用于产品方案，请重试。`;
  }
  return `${providerLabel} 未返回可写入的产品方案，请重试。`;
}
