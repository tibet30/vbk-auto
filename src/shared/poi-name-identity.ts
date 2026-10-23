/** Normalize punctuation that belongs to a single POI identity, not a route list. */
export function normalisePoiIdentityName(value: string): string {
  return value
    .replace(/([0-9一二三四五六七八九十])·(?=[0-9一二三四五六七八九十])/gu, "$1")
    .replace(/[（）()\s]/gu, "")
    .toLowerCase();
}

/** A route-list name cannot be settled as one POI. Parenthetical aliases stay one identity. */
export function isCombinedPoiPlaceName(name: string): boolean {
  const baseName = name.trim().replace(/[（(][^（）()]*[）)]/gu, "")
    .replace(/([0-9一二三四五六七八九十])·(?=[0-9一二三四五六七八九十])/gu, "$1");
  if (/[·、,，/]/u.test(baseName)) return true;

  const connector = /^(?<left>[\u3400-\u9fff]{1,24})(?:和|与|及|暨)(?<right>[\u3400-\u9fff]{1,24})$/u.exec(baseName);
  if (!connector?.groups) return false;
  const isLikelyPlace = (part: string) => /(?:景区|遗址|博物馆|广场|步行街|古城|城墙|公园|园|楼|街|塔|宫|寺|院|馆|城|山|湖|岛|窟|关|桥|巷|坊|镇|村|场|台|口|俑)$/u.test(part);
  return isLikelyPlace(connector.groups.left) && isLikelyPlace(connector.groups.right);
}
