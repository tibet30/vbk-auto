/**
 * AgentSnapshotManager 私有 no-progress blocker 助手。
 *   - noProgressBlockers：从最近的「用户输入 / 重试开启 / 已写完成」开始切
 *     片段，统计 runId 内的 noProgressBlocker 事件；
 *   - noProgressPauseMessage：把最近的 blocker 聚合成一段说明，区分
 *     approval_precondition / authorization_denied / completion_blocked 三类；
 *   - pauseAfterRepeatedBlocker：连续 3 次切到 paused 并写一次 status 事件。
 *
 * 抽出来的目的：主类文件不再夹塞一段「不变量推导」，本文件保持纯函数
 * 形态，便于在 core-snapshot.test.ts 中独立单测。
 */

import type { AgentEvent, AgentSnapshot, NoProgressBlocker } from "./types.js";
import { isMaterialWriteResult } from "./helpers.js";

export function collectNoProgressBlockers(snapshot: AgentSnapshot): AgentEvent[] {
  if (!snapshot.run) return [];
  let resetAt = -1;
  for (let index = 0; index < snapshot.events.length; index += 1) {
    const event = snapshot.events[index]!;
    if (event.runId !== snapshot.run.id) continue;
    const successfulLocalWrite = isMaterialWriteResult(event) && event.data?.remoteWrite !== true;
    if (event.type === "user" || event.data?.noProgressRetryWindow === true || successfulLocalWrite) resetAt = index;
  }
  return snapshot.events.slice(resetAt + 1).filter((event) => event.runId === snapshot.run?.id
    && typeof event.data?.noProgressBlocker === "string");
}

export function noProgressPauseMessage(blockers: AgentEvent[]): string {
  const recent = blockers.slice(-3);
  const types = [...new Set(recent.map((event) => event.data?.noProgressBlocker as NoProgressBlocker))];
  const typeText = types.map((type) => ({
    approval_precondition: "最终确认前置条件反复失效",
    authorization_denied: "连续尝试未经授权的写入",
    completion_blocked: "完成检查反复未通过",
  }[type])).join("、");
  const latestReason = recent.at(-1)?.content.trim();
  return `当前要求连续 3 次卡在：${typeText || "同一阻塞点"}，已暂停。最近一次原因：${latestReason || "未记录具体原因"}。请调整要求或明确继续后再试。`;
}

export function shouldPauseAfterBlockers(snapshot: AgentSnapshot): boolean {
  return Boolean(snapshot.run) && collectNoProgressBlockers(snapshot).length >= 3;
}