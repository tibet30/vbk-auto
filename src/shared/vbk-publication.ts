/**
 * VBK baseInfo.active 发布状态判定。
 *
 * 首次保存基本信息后平台会把 active 从 "F" 改成 "D"（后台显示「无效·下线」），
 * 此时产品仍未发布，天数等字段照常可改。只有 "T" 等其它取值视为已发布/已激活。
 * isonline / releaseActive 不在此处放宽，仍须严格等于 "F"。
 */
export function isUnpublishedActive(value: unknown): boolean {
  return value === "F" || value === "D";
}
