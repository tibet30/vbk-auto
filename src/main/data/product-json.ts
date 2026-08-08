/**
 * 产品 JSON 输入解析：
 *   - 校验入参为非空 string；
 *   - 长度超 2_000_000 字节拒绝（避免内存爆炸）；
 *   - JSON.parse 失败抛本地化错误（语法错误来自 V8 也会被改写为「JSON 格式错误：...」）；
 *   - 顶层必须是 plain object（null / array / 原始类型都拒）。
 */

const MAX_PRODUCT_JSON_LENGTH = 2_000_000;

/**
 * 把外部传入的产品 JSON 文本解析为 plain object，并做基础合法性检查。
 *
 * 错误一律抛 Error（文案已本地化），供上层 IPC 直接展示给用户。
 */
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
