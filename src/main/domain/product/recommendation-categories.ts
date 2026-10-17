/**
 * 产品推荐理由分类领域契约。
 *
 * 该白名单同时被产品校验、AI 规划与 VBK 自动录入使用，因此必须位于
 * 与具体工作流无关的领域层，避免 planning/data 反向依赖 automation。
 */

/**
 * 产品全链路唯一可用的推荐理由分类。
 *
 * 这是持久化兼容集合，不再代表某个产品当前可选项。规划与保存必须读取
 * VBK QConfig + 类别目录得到动态策略，不能用本常量代替实时门禁。
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
  "缤纷体验",
] as const;

/** 保留语义化导出名；它与产品契约共用同一份值，禁止再次出现分叉。 */
export const VBK_RECOMMENDATION_CATEGORIES = RECOMMENDATION_CATEGORIES;

/** 旧调用方的兼容导出；新规划代码不得把它当作实时策略。 */
export const VBK_SELECTABLE_RECOMMENDATION_CATEGORIES = [
  "服务保障",
  "贴心赠送",
  "精选酒店",
  "特色美食",
  "缤纷体验",
] as const;
