/** Bare experiences are not attractions. Named venues never match this predicate. */
export function isIndependentItineraryExperience(name: string): boolean {
  return /^(?:泼水成冰|马拉爬犁|滑雪|骑马|骑行|徒步)(?:约?(?:\d+(?:\.\d+)?|[一二三四五六七八九十半]+)(?:小时|分钟))?(?:体验)?$/u
    .test(name.replace(/\s+/gu, ''));
}

export function experienceNameKey(name: string): string {
  return name.replace(/[\s·•・]/gu, '').replace(/约(?=[\d一二三四五六七八九十半])/gu, '');
}
