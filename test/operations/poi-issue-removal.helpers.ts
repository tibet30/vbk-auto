export function hasNoPoiIssue(product: Record<string, unknown>): boolean {
  return !Array.isArray(product.itinerary) || !product.itinerary.some((day) => {
    const spots = Array.isArray((day as { spots?: unknown[] })?.spots) ? (day as { spots: unknown[] }).spots : [];
    return spots.some((spot) => (spot as { name?: string })?.name === '松花湖');
  });
}
