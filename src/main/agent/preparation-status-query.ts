import type { AgentRunStatus, AgentSnapshot, ProductDetail } from "../../shared/contracts.js";
import { evaluatePreparationCompletion } from "../planning/preparation-completion.js";

const STATUS_QUERY = /^(?:(?:当前|目前)?(?:状态|进度)(?:如何|怎么样|是什么|到哪一步了)?|现在到哪(?:一步)?|卡在哪|哪里卡住|完成了么|完成了吗|是否完成|还有什么没完成)[？?！!。.\s]*$/u;
const CHANGES_WORK = /继续|恢复|重试|重新|修改|调整|替换|删除|生成|规划|补齐|执行|录入|确认/u;

export function isPreparationStatusQuery(content: string): boolean {
  const text = content.trim();
  return STATUS_QUERY.test(text) && !CHANGES_WORK.test(text);
}

export function preparationStatusReply(snapshot: AgentSnapshot, product?: ProductDetail): string {
  const status = statusLabel(snapshot.run?.status);
  const recent = [...snapshot.events].reverse().find((event) => event.type === "status" && event.content.trim());
  if (!product) return `当前运行状态：${status}。${recent ? `最近状态：${recent.content}` : "尚无保存的产品进度。"}`;
  const evaluation = evaluatePreparationCompletion(product, snapshot);
  const missing = evaluation.missing.slice(0, 5).join("、") || "无";
  return `当前运行状态：${status}；当前节点：${nodeLabel(evaluation.currentNode)}；缺项：${missing}。${recent ? `最近状态：${recent.content}` : ""}`;
}

function statusLabel(status: AgentRunStatus | undefined): string {
  return ({ running: "正在规划", paused: "已暂停", waiting_input: "等待补充", waiting_approval: "等待确认", completed: "已完成", failed: "失败", queued: "等待开始", abandoned: "已放弃" } as Record<string, string>)[status ?? ""] ?? "未开始";
}

function nodeLabel(node: string): string {
  return ({ skeleton: "基础信息", spotCandidates: "景点候选", itineraryDraft: "生成行程", poiResolution: "核验 POI", hotelResolution: "匹配酒店", copy: "补齐文案", presentation: "补齐推荐", commercial: "补齐套餐", cover: "补齐封面", vehicleResource: "匹配用车", finalValidation: "最终核验" } as Record<string, string>)[node] ?? "最终核验";
}
