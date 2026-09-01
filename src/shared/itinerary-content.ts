/** 判断一天是否包含可替代 POI 的、来自用户的“其他”活动。 */
export function dayHasUserOtherActivity(day: unknown): boolean {
  if (!day || typeof day !== "object" || Array.isArray(day)) return false;
  const activities = (day as Record<string, unknown>).activities;
  if (!Array.isArray(activities)) return false;
  return activities.some((activity) => {
    if (!activity || typeof activity !== "object" || Array.isArray(activity)) return false;
    const row = activity as Record<string, unknown>;
    return row.source === "user"
      && (row.type === "other" || row.type === "free")
      && hasText(row.time)
      && hasText(row.title)
      && hasText(row.detail);
  });
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
