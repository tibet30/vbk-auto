/**
 * 「基础信息」action 的对外形状字段 + 字段名 ↔ 中文文案 映射：
 *   - UpdateField：与 basicInfoSaving / basicInfoErrors 的 key 对齐；
 *   - fieldLabel：UI 文案 / 错误提示统一来源。
 */

export type UpdateField =
  | "subtitle"
  | "butler"
  | "adult"
  | "child"
  | "minimumTravelers"
  | "inventory"
  | "requestedTotalCost"
  | "cover";

export function fieldLabel(field: UpdateField): string {
  return ({
    subtitle: "副标题",
    butler: "管家联系人",
    adult: "成人价",
    child: "儿童价",
    minimumTravelers: "起订人数",
    inventory: "班期库存",
    requestedTotalCost: "全程用车总成本",
    cover: "产品封面",
  } as Record<UpdateField, string>)[field];
}