/** Only the ordered travel path precedes route metadata and the unordered highlights list. */
export function orderedItineraryRoutePath(source: string): string {
  return source.split(/(?:海拔|柏油路|行车里程|车程|看点|亮点|游览看点)\s*[:：]/u, 1)[0]!;
}
