/**
 * 行程文案自动改写请求：只包含被平台驳回的命中文案，AI 只能按 targets 返回替换值。
 * 放在 shared 是为了让 minimax 侧（改写器实现）与 automation 侧（改写调用方）
 * 使用同一种请求形状，而不互相依赖实现模块。
 */

export interface ItineraryCopyRewriteTarget {
  path: string;
  value: string;
}

export interface ItineraryCopyRewriteRequest {
  message: string;
  product: Record<string, unknown>;
  targets: ItineraryCopyRewriteTarget[];
}

/** automation 侧与本接口的兼容类型：请求可带路径，返回值形状与 AiResponse 一致。 */
export type ItineraryCopyRewriter = (request: ItineraryCopyRewriteRequest) => Promise<import("./contracts-types/ai-response.js").AiResponse>;
