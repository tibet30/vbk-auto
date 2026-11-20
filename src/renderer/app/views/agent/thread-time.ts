// 任务列表的相对时间文案：把 ISO 时间换算成「刚刚 / N 分钟前 / N 小时前 / N 天前」。
export function relativeThreadTime(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const elapsed = now - at;
  if (elapsed < 60_000) return "刚刚";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
