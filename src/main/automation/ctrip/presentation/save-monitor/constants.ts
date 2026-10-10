/**
 * Save monitor 路径常量 + 默认超时。
 *
 *   - SAVE_DESCRIPTION_INFO_PATH：携程官方「保存产品描述」endpoint 路径片段；
 *   - CHECK_SENSITIVE_WORD_PATH：携程官方「产品描述敏感词检测」endpoint 路径片段；
 *   - DEFAULT_SAVE_TIMEOUT_MS：默认等待官方保存响应的总时长；
 *   - DEFAULT_SENSITIVE_WORD_TIMEOUT_MS：默认等待敏感词先于保存回响的额外时长。
 *
 * 仅匹配路径片段，忽略 query string；不读取 URL 中的任何凭据信息。
 */

/** 携程官方「保存产品描述」endpoint 路径片段；忽略 query string。 */
export const SAVE_DESCRIPTION_INFO_PATH = "/15638/savedescriptioninfo";

/** 携程官方「产品描述敏感词检测」endpoint 路径片段。 */
export const CHECK_SENSITIVE_WORD_PATH = "/15638/checkSensitiveWord";

/** 默认等待官方保存响应的总时长（ms）。 */
export const DEFAULT_SAVE_TIMEOUT_MS = 15_000;

/** 默认等待敏感词先于保存回响的额外时长（ms）。 */
export const DEFAULT_SENSITIVE_WORD_TIMEOUT_MS = 6_000;

/**
 * 监听官方 endpoint 路径：只看 path 含目标片段（容忍 query string、协议、host 差异），
 * 不读取 URL 里的任何凭据信息。
 */
export function pathMatches(urlValue: string, target: string): boolean {
  if (typeof urlValue !== "string") return false;
  try {
    const parsed = new URL(urlValue);
    return parsed.pathname.includes(target);
  } catch {
    return urlValue.includes(target);
  }
}