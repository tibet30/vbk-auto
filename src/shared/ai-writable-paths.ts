/**
 * AI / Agent 可写入的产品 JSON 子树根。planning 与 RFC6902 patch 共用，
 * 避免两条协议出现不同的可写边界。
 */
export const AI_WRITABLE_PATHS = {
  basicInfo: "/basicInfo",
  presentation: "/presentation",
  itinerary: "/itinerary",
  packageName: "/commercial/packageName",
  pricing: "/commercial/pricing",
  inventory: "/commercial/inventory",
  terms: "/commercial/terms",
  release: "/commercial/release",
  skeleton: "/operations",
  researchTasks: null,
} as const;

export type AiWritablePath = NonNullable<(typeof AI_WRITABLE_PATHS)[keyof typeof AI_WRITABLE_PATHS]>;

export function isAiWritablePatchPath(path: string): boolean {
  const roots = Object.values(AI_WRITABLE_PATHS).filter((value): value is AiWritablePath => typeof value === "string");
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}
