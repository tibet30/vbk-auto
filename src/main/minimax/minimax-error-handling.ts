
export const normalizeWhitespace = (value: string) => value.replace(/[\s\u00a0\t\r\n]+/g, " ").trim();

const ignoreStructuralKeys = new Set(["code"]);

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

export function toRetryHint(reason: string, maxLength = 180): string {
  const normalized = stripRetryHintTail(normalizeWhitespace(reason)).slice(0, maxLength);
  if (!normalized) return "本轮结构化结果无法解析。";
  return normalized;
}

export function isStructuredFormatFailure(reason: string) {
  if (!reason) return false;
  if (/(?:structured response rejected|Unexpected end of JSON input|hasJsonFence|JSON.parse|Unexpected token|不是有效 JSON|不是合法 JSON|解析.*失败|响应格式|返回的数据格式)/i.test(reason)) return true;
  return false;
}

export function classifyMiniMaxError(error: unknown): string {
  const reason = extractMiniMaxFailureReason(error);
  if (reason && isStructuredFormatFailure(reason)) return "invalid_model_output";
  if (reason) {
    if (isStructuredFormatFailure(reason)
      || /(?:MiniMax 返回的数据格式无法用于产品方案|MiniMax 未返回可写入的产品方案|MiniMax 未返回可写入的结构化内容|未返回可写入的产品方案|返回的数据格式无法用于产品方案)/i.test(reason)) {
      return "invalid_model_output";
    }
    if (/(?:MiniMax 未返回内容|未返回有效响应|empty_model_output)/i.test(reason)) {
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

export function normalizeFailureMessage(errorCode: string, reason: string): string {
  const normalizedReason = reason && reason.trim() ? reason : "AI 服务暂时无法完成本次请求。";
  const stripTrailingRetryInstruction = (message: string) => stripRetryHintTail(message);

  const stripConnectionHint = (message: string) => {
    let normalized = message;
    const connectionPatterns = [
      /\s*请(?:先)?(?:检查|确认|核实)\s*(?:网络|连接|网络连接|配置|网路|联网|MiniMax API|MiniMax)\s*(?:或(?:配置|网络|连接|鉴权|服务|API|token))?\s*(?:后|之后)?(?:可)?(?:重试|再试|重联|复试)[。!！]?\s*$/gu,
      /\s*请(?:先)?(?:检查|确认|核实)[^。!！]*?(?:后|之后)?(?:可)?(?:重试|再试|重联|复试)[。!！]?\s*$/gui,
      /\s*请先确认.*?后?\s*(?:可)?(?:重试|再试)[。!！]?/gui,
      /\s*[，。；;]请(?:先)?(?:检查|确认|核实|验证|校验)\s*(?:MiniMax|MiniMax API|网络|连接|网络连接|配置|网路|联网|服务|token)[^。!！;；,，]*(?:后|之后|之后再)?\s*(?:可)?\s*(?:重试|再试|再请求|复试|再次尝试|再次请求|尝试)[。!！;；,，]?\s*$/gui,
      /\s*[，。；;,，\s]*请(?:先)?(?:检查|确认|核实|验证|校验|检查并确认)[\s\S]{0,120}?(?:连接|配置|网络|API|MiniMax)[\s\S]{0,120}?(?:后|之后|之后再|再|再次)?(?:可)?(?:尝试|重试|再试|重试一下|重新发送|再次请求)[。!！;；,，\s]*$/gui,
      /\s*[，。；;,，\s]*Please\s+check[\s\S]{0,140}?(?:API|configuration|network|connection|token)[\s\S]{0,140}?(?:retry|re-?try|attempt|request)[。!！;；,，\s]*$/gui,
      /\s*[，。；;,，\s]*请(?:先)?(?:检查|确认|核实|验证|校验)[\s\S]{0,140}?(?:API|MiniMax|网络|连接|配置)[\s\S]{0,140}?(?:后再(?:次)?尝试|后重试|再尝试|再次请求)[。!！;；,，\s]*$/gui,
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
      || /返回的数据格式无法用于产品方案|MiniMax 返回的数据格式无法用于产品方案|structured response rejected/i.test(normalizedForStructured)
    ) {
      return "MiniMax 返回的数据格式无法用于产品方案，请重试。";
    }
    return "MiniMax 未返回可写入的产品方案，请重试。";
  }
  if (errorCode === "empty_model_output") {
    return "MiniMax 未返回可写入的产品方案，请重试。";
  }

  if (!(errorCode === "invalid_model_output" || errorCode === "empty_model_output") && !isStructuredFormatFailure(normalizedReason)) {
    return `${normalizedReason} 请检查连接或配置后重试。`;
  }
  if (/(?:返回的数据格式无法用于产品方案|structured response rejected|MiniMax 返回的数据格式无法用于产品方案)/i.test(normalizedReason)) {
    return "MiniMax 返回的数据格式无法用于产品方案，请重试。";
  }
  return "MiniMax 未返回可写入的产品方案，请重试。";
}
