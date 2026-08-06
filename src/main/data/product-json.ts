const MAX_PRODUCT_JSON_LENGTH = 2_000_000;

export function parseProductJson(json: unknown): Record<string, unknown> {
  if (typeof json !== "string") throw new Error("JSON 内容格式不正确。");
  if (!json.trim()) throw new Error("JSON 内容不能为空。");
  if (json.length > MAX_PRODUCT_JSON_LENGTH) throw new Error("JSON 内容过大，无法保存。");

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const detail = error instanceof SyntaxError ? error.message : "无法解析 JSON。";
    throw new Error(`JSON 格式错误：${detail}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("产品 JSON 的最外层必须是一个对象。");
  }
  return parsed as Record<string, unknown>;
}
