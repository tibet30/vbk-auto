import { formatProductExecutionTime, type ProductExecutionTime } from "../../../shared/product-execution-time.js";

export function ProductExecutionTimeLabel({ time }: { time?: ProductExecutionTime }) {
  const explanation = "累计 AI 调用与函数执行耗时；暂停、等待输入、审批和排队不计时，并行执行不重复累计。";
  return <span title={`${explanation}${time?.historicalIncomplete ? "历史日志不完整，显示已确认的累计耗时。" : ""}`}>
    已消耗 {formatProductExecutionTime(time)}
  </span>;
}
