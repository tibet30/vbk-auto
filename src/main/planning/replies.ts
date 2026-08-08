/**
 * 系统生成的 assistant 回复文本。
 *
 *  严格基于 orchestrator 实际接受的 / 拒绝的 / 缺失的模块；模型声称的
 *  「已完整 / 完成」绝不会被采信。渲染到 UI 与写入 assistant message 都
 *  用同一份。
 */

import type { ModuleOutcome, PlanningGenerationState, PlanningStage } from "../../shared/contracts-planning.js";

export function composeStageAssistantReply(stage: PlanningStage, accepted: ModuleOutcome[], rejected: ModuleOutcome[]): string {
  const acceptedList = accepted.filter((m) => m.status === "accepted").map((m) => m.module);
  const rejectedList = rejected.map((m) => `${m.module}${m.reason ? `（${m.reason}）` : ""}`);
  if (acceptedList.length === 0 && rejectedList.length === 0) {
    return `【${stage}】本阶段没有产出模块。`;
  }
  return `【${stage}】接受：${acceptedList.join("、") || "（无）"}；拒绝 / 缺失：${rejectedList.join("、") || "（无）"}。`;
}

/**
 * 找出 state.stages 里最近一条带 lastError 的记录；用于在「继续规划」无进展
 * 时把失败原因透传给 UI（避免用户看到相同摘要却不知道下一步该做什么）。
 */
function latestStageLastError(state: PlanningGenerationState): { stage: PlanningStage; message: string; code: string } | undefined {
  if (!state.stages?.length) return undefined;
  // 反向扫：stages 数组按 stage 顺序追加；但安全起见用 updatedAt 倒序定位。
  const withError = state.stages.filter((s) => s.lastError && s.lastError.message);
  if (withError.length === 0) return undefined;
  const latest = withError[withError.length - 1];
  return latest?.lastError
    ? { stage: latest.stage, message: latest.lastError.message, code: latest.lastError.code }
    : undefined;
}

export function composeAssistantReply(state: PlanningGenerationState, accepted: ModuleOutcome[], rejected: ModuleOutcome[]): string {
  const acceptedList = accepted.filter((m) => m.status === "accepted").map((m) => m.module);
  const missingList = rejected.filter((m) => m.status === "missing").map((m) => m.module);
  const rejectedList = rejected.filter((m) => m.status === "rejected").map((m) => `${m.module}${m.reason ? `（${m.reason}）` : ""}`);
  if (state.status === "completed") {
    return `方案规划完成（实际接受模块：${acceptedList.join("、")}）。运营人员可以核查每条 research task 后进入自动录入。`;
  }
  const base = `方案规划未完成。已接受：${acceptedList.join("、") || "（无）"}；缺失：${missingList.join("、") || "（无）"}；拒绝：${rejectedList.join("、") || "（无）"}。`;
  // 「继续规划无进展」可观测性：当用户刚点完续跑、persisted state 仍只有
  // 之前已接受模块 + 当前阶段的 lastError 没有新进展时，把 lastError.message
  // 拼到 reply 末尾，避免用户看到相同摘要却不知道下一步该做什么。
  const lastError = latestStageLastError(state);
  if (lastError && (lastError.code === "missing_module" || lastError.code === "unknown" || lastError.code === "invalid_model_output" || lastError.code === "empty_model_output")) {
    return `${base}最近失败（${lastError.stage}）：${lastError.message}。请调整输入或对话补充后再次点击「继续规划」。`;
  }
  // 用户报告「控制台看不到任何日志」：当 status=needs_user 且无 lastError
  // 时（极少见但确实可能——比如 validation 阶段 deep-validate 后 rewind 但
  // 没记录 lastError），也要明确指向 stage 和 DevTools 日志路径。
  if (state.status === "needs_user" && state.currentStage) {
    return `${base}当前等待阶段：${state.currentStage}。请打开 DevTools 查看 [planning] 日志或调整输入后再次点击「继续规划」。`;
  }
  return base;
}