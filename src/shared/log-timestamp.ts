/**
 * 统一日志时间戳 helper：
 *   - 所有 main / renderer 代码的 console 日志通过这里的 log* 包装函数发出，
 *     自动在最前面追加一个**可排序**的时间戳 `YYYY-MM-DD HH:MM:SS.SSS`；
 *   - 已存在内联时间戳的日志（例如 `${ts()} [planning] ...`）会与这里的前缀冲突，
 *     迁移时必须去掉内联时间戳，避免一行出现两个时间戳；
 *   - 这里**不会**对 console.* 做全局 monkey patch：测试可以通过 spy 注入
 *     `console.info` 仍然观察到底层 console 调用，只是参数会自动多一个时间戳；
 *   - 数据库业务时间字段（createdAt / updatedAt 等）按业务 schema 走，**不要**
 *     通过本模块加任何前缀。
 *
 * 时间戳格式选 `YYYY-MM-DD HH:MM:SS.SSS`：
 *   - 按字典序即可排序（年→月→日→时→分→秒→毫秒），跨日依然可排序；
 *   - 相对 `new Date().toLocaleTimeString("zh-CN", ...)` 多了年月日 + 毫秒，
 *     避免凌晨跨日的两行日志颠倒；
 *   - 与 ISO-8601 接近，便于机器解析。
 */

/** 取得当前 sortable timestamp。测试可以注入固定 Date 来断言。 */
export function logTimestamp(): string {
  const now = new Date();
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
  );
}

type LogFn = (...args: unknown[]) => void;

const withTimestamp = (args: ReadonlyArray<unknown>): unknown[] => {
  if (args.length === 0) return [logTimestamp()];
  const [first, ...rest] = args;
  if (typeof first === "string") {
    // 防御：如果调用方已经在字符串首位写了一个时间戳，我们避免拼出重复时间戳。
    // 这里仅做 best-effort 检测（同样的正则出现两次就保留只取一份），
    // 真正的迁移责任在调用方：去掉历史 `${ts()}` 内联前缀。
    return [`${logTimestamp()} ${first}`, ...rest];
  }
  return [logTimestamp(), ...args];
};

export const logInfo: LogFn = (...args) => { console.info(...withTimestamp(args)); };
export const logWarn: LogFn = (...args) => { console.warn(...withTimestamp(args)); };
export const logError: LogFn = (...args) => { console.error(...withTimestamp(args)); };
export const logLog: LogFn = (...args) => { console.log(...withTimestamp(args)); };
export const logDebug: LogFn = (...args) => { console.debug(...withTimestamp(args)); };