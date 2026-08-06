// 主进程数据库错误统一在这里定义，避免 main.ts 里到处写 "项目不存在" 的
// 字面量字符串，也方便 IPC 端按 name === 'VbkDatabaseError' 区分业务错误
// vs 系统错误，给到 UI 的提示更精准。
export class VbkDatabaseError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "VbkDatabaseError";
  }
}

export function projectNotFound(id: string): Error {
  return new VbkDatabaseError("project_not_found", `项目不存在：${id}`);
}
