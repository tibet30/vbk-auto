/**
 * Names with these suffixes describe route POIs or local areas in itinerary
 * fields. Administrative lookup and lodging anchors cannot reclassify them as
 * transport-only city nodes; real administrative cities/counties remain
 * eligible because 市、县、旗 and bare city names are intentionally absent.
 */
const ROUTE_POI_SUFFIX = /(?:村|镇|景区|城区|园区|片区|街区|社区|校区|厂区|矿区|库区)$/u;

export function isProtectedRoutePoiPlaceName(name: string): boolean {
  return ROUTE_POI_SUFFIX.test(name.trim());
}
