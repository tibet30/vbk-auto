/** Local execution telemetry; never part of product business JSON. */
export interface ProductExecutionTime {
  elapsedMs: number;
  running: boolean;
  /** Older products only include intervals supported by retained logs. */
  historicalIncomplete: boolean;
}

export function formatProductExecutionTime(time: ProductExecutionTime | undefined): string {
  if (!time) return "暂无记录";
  if (time.historicalIncomplete && time.elapsedMs === 0) return "暂无记录";
  const seconds = Math.floor(Math.max(0, time.elapsedMs) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const rest = seconds % 60;
  return `${time.historicalIncomplete ? "至少 " : ""}${hours ? `${hours} 小时 ` : ""}${minutes || hours ? `${minutes} 分 ` : ""}${rest} 秒`;
}
