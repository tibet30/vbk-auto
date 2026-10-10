import type { AgentSnapshot } from "../../shared/contracts.js";

export const PRODUCT_PREPARATION_INSTRUCTION =
  "请读取刚创建的产品和用户要求，完成本地规划与资源核验；任何 VBK 写入都必须先请求明确审批。";

/** Explicit preparation requests must produce a plan, even if the model only reads. */
export function isPreparationRun(snapshot: AgentSnapshot): boolean {
  const latest = [...snapshot.events].reverse().find(event => event.runId === snapshot.run?.id && event.type === "user");
  // A narrowly requested read-only reconciliation must not regenerate a saved
  // itinerary merely because this run began as preparation months earlier.
  if (latest && /^仅进行只读恢复[:：]/u.test(latest.content)
    && latest.content.includes("read_vbk_creation_recovery")) return false;
  return snapshot.events.some((event) => event.runId === snapshot.run?.id && event.type === "user"
    && isPreparationInstruction(event.content));
}

export function isPreparationInstruction(content: string): boolean {
  return content.startsWith("请读取刚创建的产品和用户要求")
    || /(?:完成|继续|开始|恢复|补齐).{0,12}(?:本地规划|产品规划|规划与资源核验)/u.test(content);
}
