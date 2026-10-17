/** Explicit common names that the VBK catalog resolves to the same named POI. */
export function isKnownPoiNameAlias(left: string, right: string): boolean {
  const groups = [
    /^(?:羊卓雍湖|羊卓雍措|羊卓雍错)$/u,
    /^(?:扎达土林|札达土林|札达土林国家地质公园)$/u,
    /^(?:冈仁波齐|远眺冈仁波齐|冈仁波齐山体冰川遗迹)$/u,
  ];
  const a = compact(left);
  const b = compact(right);
  return groups.some((group) => group.test(a) && group.test(b));
}

function compact(value: string): string {
  return value.replace(/[\s\p{Cf}]+/gu, "").trim();
}
