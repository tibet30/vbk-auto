import { useState, type Dispatch, type SetStateAction } from "react";
import { logInfo, logWarn } from "../../../../shared/log-timestamp.js";
import type { PlanningGenerationState, PlanningMajorStage } from "../../../../shared/contracts-planning.js";
import { api } from "../../helpers";
import type { AppStateBase } from "../base";

type PlanningActionsOptions = {
  product: AppStateBase["product"];
  planningState: PlanningGenerationState | null;
  setPlanningState: Dispatch<SetStateAction<PlanningGenerationState | null>>;
  setNotice: (value: string | null) => void;
};

/** 规划续跑、行程采用和阶段重做的操作状态与用户反馈。 */
export function usePlanningActions({
  product,
  planningState,
  setPlanningState,
  setNotice,
}: PlanningActionsOptions) {
  // 续跑按钮点击锁：点击后到 planning.state 携新状态返回前，避免重复点击造成双触发。
  const [planningBusy, setPlanningBusy] = useState(false);
  // 阶段重做锁精确到 major stage，避免三个按钮一起显示 spinner；主进程仍会以产品工作流锁做最终裁决。
  const [planningRerunBusy, setPlanningRerunBusy] = useState<PlanningMajorStage | null>(null);
  const [planningAcceptBusy, setPlanningAcceptBusy] = useState(false);

  /** 用户手动续跑入口：后端从持久化 currentStage 续跑，不会丢失已合法落地的模块。 */
  const planningResume = async () => {
    if (!product || !api() || planningBusy || planningRerunBusy || planningAcceptBusy) return;
    setPlanningBusy(true);
    logInfo("[App] planning.resume click", { localProductId: product.id, planningStateStatus: planningState?.status, currentStage: planningState?.currentStage });
    setNotice("正在续跑规划…");
    try {
      const result = await api()!.planning.resume(product.id);
      if (result.state) setPlanningState(result.state);
      const acceptedNames = (result.accepted ?? []).slice();
      const rejectedNames = (result.rejected ?? []).map((r) => r.module);
      const previouslyAccepted = new Set<string>();
      for (const s of planningState?.stages ?? []) {
        for (const m of s.accepted ?? []) previouslyAccepted.add(m.module);
      }
      const newlyAccepted = acceptedNames.filter((m) => !previouslyAccepted.has(m));
      logInfo("[App] planning.resume result", { localProductId: product.id, status: result.status, accepted: acceptedNames, newlyAccepted, rejected: rejectedNames });
      const summary = result.assistantReply
        || (acceptedNames.length ? `已接受：${acceptedNames.join("、")}。` : "")
        + (rejectedNames.length ? `缺失：${rejectedNames.join("、")}。` : "");
      if (result.status === "needs_user" && newlyAccepted.length === 0 && acceptedNames.length > 0) {
        setNotice(`续跑未取得进展：${summary}请查看 DevTools 中 [planning] 日志或调整对话后重试。`);
      } else {
        setNotice(summary || "续跑完成");
      }
    } catch (error) {
      logWarn("[App] planning.resume failed", { localProductId: product.id, error });
      setNotice(`续跑失败：${(error as { message?: string })?.message ?? String(error)}。请打开 DevTools 查看 [planning] 日志。`);
    } finally {
      setPlanningBusy(false);
    }
  };

  const planningAcceptItinerary = async () => {
    if (!product || !api() || planningAcceptBusy || planningBusy || planningRerunBusy) return;
    setPlanningAcceptBusy(true);
    setNotice("正在核验当前行程的真实 POI，核验通过后会重新补全产品…");
    try {
      const result = await api()!.planning.acceptItineraryAndRerunCompletion(product.id);
      if (result.state) setPlanningState(result.state);
      setNotice(result.status === "completed"
        ? "新行程已采用，产品补全已完成，已回到产品审查。"
        : result.assistantReply || "行程已采用，产品补全正在继续。请留意规划树状态。");
    } catch (error) {
      const message = (error as { message?: string })?.message ?? String(error);
      logWarn("[App] planning.acceptItineraryAndRerunCompletion failed", { localProductId: product.id, error });
      setNotice(message);
    } finally {
      setPlanningAcceptBusy(false);
    }
  };

  const planningRerunMajorStage = async (stage: PlanningMajorStage) => {
    if (!product || !api() || planningRerunBusy || planningBusy || planningAcceptBusy) return;
    const localProductId = product.id;
    setPlanningRerunBusy(stage);
    const stageLabel = majorStageLabel(stage);
    setNotice(`正在重做${stageLabel}阶段…`);
    try {
      const result = await api()!.planning.rerunMajorStage(localProductId, stage);
      if (result.state) setPlanningState(result.state);
      if (result.status === "completed") {
        setNotice(`${stageLabel}阶段已重做完成。`);
      } else if (result.status === "needs_user") {
        setNotice(result.assistantReply || `${stageLabel}阶段需要补充信息，请查看规划树。`);
      } else if (result.status === "failed") {
        setNotice(result.assistantReply || `${stageLabel}阶段未通过，请检查规划树后重试。`);
      } else {
        setNotice(result.assistantReply || `${stageLabel}阶段已启动，请留意规划树状态。`);
      }
    } catch (error) {
      const message = (error as { message?: string })?.message ?? String(error);
      logWarn("[App] planning.rerunMajorStage failed", { localProductId, stage, error });
      setNotice(`重做失败：${message}`);
    } finally {
      setPlanningRerunBusy(null);
    }
  };

  return {
    planningResume,
    planningBusy,
    planningAcceptItinerary,
    planningAcceptBusy,
    planningRerunMajorStage,
    planningRerunBusy,
  };
}

function majorStageLabel(stage: PlanningMajorStage): string {
  if (stage === "foundation") return "产品骨架";
  if (stage === "itinerary") return "行程规划";
  return "产品补全";
}
