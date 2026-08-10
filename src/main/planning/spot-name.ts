/**
 * 新生成的 spot 必须能独立映射到一个 VBK POI。括号内通常是同一地点的
 * 别名/入口说明，不能据此把单点误判为组合地点。
 */
export function isCombinedSpotName(name: string): boolean {
  const baseName = name.trim().replace(/[（(][^（）()]*[）)]/g, "");
  if (/[·、/]/.test(baseName)) return true;

  const connector = /^(?<left>[\u3400-\u9fff]{1,24})(?:和|与|及|暨)(?<right>[\u3400-\u9fff]{1,24})$/u.exec(baseName);
  if (!connector?.groups) return false;
  // 避免把「和平饭店」「颐和园景区」一类本身含“和”的单一正式名称误判。
  const isLikelyPlace = (part: string) => /(?:景区|遗址|博物馆|广场|步行街|古城|城墙|公园|园|楼|街|塔|宫|寺|院|馆|城|山|湖|岛|窟|关|桥|巷|坊|镇|村|场|台|口|俑)$/.test(part);
  return isLikelyPlace(connector.groups.left) && isLikelyPlace(connector.groups.right);
}
