/**
 * 主进程数据库层统一错误类型 VbkDatabaseError 及其常见工厂方法。
 *
 *  统一在这里定义业务错误而不是在 main.ts 散落字面量字符串，便于：
 *   - IPC 端按 `name === 'VbkDatabaseError'` 区分业务错误 vs 系统错误；
 *   - UI 端按 code 拿到本地化文案；
 *   - 测试里用 instanceof / code 稳定判定。
 */

export class VbkDatabaseError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "VbkDatabaseError";
  }
}

/**
 * 构造「产品不存在」业务错误：用于数据库层找不到 localProductId 时抛出，UI 端按 name/code 区分。
 */
export function productNotFound(id: string): Error {
  return new VbkDatabaseError("product_not_found", `产品不存在：${id}`);
}
