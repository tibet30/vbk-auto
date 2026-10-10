type Info = Record<string, unknown>;

function timeRank(node: Info): number | undefined {
  const time = node.takeoffTime as { name?: string } | undefined;
  const value = time?.name?.trim() ?? "";
  const clock = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (clock && Number(clock[1]) < 24 && Number(clock[2]) < 60) return Number(clock[1]) * 60 + Number(clock[2]);
  // These are ordering anchors only; the stored time remains unchanged.
  if (value === "上午") return 9 * 60;
  if (value === "下午") return 14 * 60;
  return undefined;
}

/** Place generated meals around timed activities without changing business-card order
 * or moving untimed pickup, all-day transport, hotels and departure anchors. */
export function orderItineraryMeals(infos: Info[]): Info[] {
  const timed = infos.filter(node => timeRank(node) !== undefined);
  const meals = timed.filter(node => (node.activeType as { name?: string })?.name === "餐饮");
  const ordered = timed.filter(node => !meals.includes(node));
  for (const meal of meals.sort((a, b) => timeRank(a)! - timeRank(b)!)) {
    const index = ordered.findIndex(node => timeRank(node)! > timeRank(meal)!);
    ordered.splice(index < 0 ? ordered.length : index, 0, meal);
  }
  let position = 0;
  return infos.map((node, index) => ({ ...(timeRank(node) === undefined ? node : ordered[position++]!), sort: index + 1 }));
}
