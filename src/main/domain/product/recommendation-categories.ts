/**
 * 产品推荐理由分类领域契约。
 *
 * 该白名单同时被产品校验、AI 规划与 VBK 自动录入使用，因此必须位于
 * 与具体工作流无关的领域层，避免 planning/data 反向依赖 automation。
 */

/**
 * 产品全链路唯一可用的推荐理由分类。
 *
 * 这些值必须与 VBK 产品图文页下拉完全一致。此前这里维护了一个 15 项
 * 的产品 JSON 白名单，而录入页实际只有 9 项，导致本地 readiness 通过后
 * 在 VBK 选择分类时失败。现在将产品契约直接收敛到 VBK 的真实选项。
 */
export const RECOMMENDATION_CATEGORIES = [
  "优选行程",
  "服务保障",
  "贴心赠送",
  "精选酒店",
  "缤纷景点",
  "特色美食",
  "度假首选",
  "超值赠送",
  "五星精选",
] as const;

/** 保留语义化导出名；它与产品契约共用同一份值，禁止再次出现分叉。 */
export const VBK_RECOMMENDATION_CATEGORIES = RECOMMENDATION_CATEGORIES;

/** 当前 VBK 合同下推荐理由三行稳定可选的分类；其余分类可能展示但为 disabled。 */
export const VBK_SELECTABLE_RECOMMENDATION_CATEGORIES = [
  "服务保障",
  "贴心赠送",
  "精选酒店",
  "特色美食",
] as const;
