/**
 * MiniMax 服务层错误类型：携带 code（机器可读）+ message（人类可读）+ details（可选技术细节）。
 * 上层可通过 instanceof 检测并按 code 分类渲染给用户。
 */
export class MiniMaxServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: string,
  ) { super(message); }
}
