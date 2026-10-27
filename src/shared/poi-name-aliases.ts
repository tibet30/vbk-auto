/** Explicit common names that the VBK catalog resolves to the same named POI. */
export function isKnownPoiNameAlias(left: string, right: string): boolean {
  const groups = [
    /^(?:羊卓雍湖|羊卓雍措|羊卓雍错)$/u,
    /^(?:扎达土林|札达土林|札达土林国家地质公园)$/u,
    /^(?:冈仁波齐|远眺冈仁波齐|冈仁波齐山体冰川遗迹)$/u,
    /^(?:古格王朝|古格王朝遗址|古格王国遗址)$/u,
    /^(?:希夏邦马|希夏邦马峰)$/u,
    /^(?:珠峰绒布冰川遗迹|绒布冰川)$/u,
  ];
  const a = compact(left);
  const b = compact(right);
  return groups.some((group) => group.test(a) && group.test(b))
    || (a.length >= 3 && b.length >= 3 && /[措错]$/u.test(a) && /[措错]$/u.test(b)
      && a.replace(/措$/u, '错') === b.replace(/措$/u, '错'))
    // 「雾淞」是「雾凇」的高频手写变体；只在整名等价时生效，不做子串猜测。
    || (a.length >= 3 && b.length >= 3 && a.replace(/淞/gu, '凇') === b.replace(/淞/gu, '凇'));
}

function compact(value: string): string {
  return value.replace(/[\s\p{Cf}]+/gu, "").trim();
}
