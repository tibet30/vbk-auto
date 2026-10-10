/**
 * 核查与确认类 handler：
 *   - confirmTask：把运营填写的核查结果提交到 main 端，并触发一次 AI 续答
 *     以更新产品草稿；
 *   - resolveVehicleTask：让 VBK 后端去匹配一个用车资源组；成功后刷新 readiness；
 *   - refreshResearchIssues：重算并清理已由当前 product_json 满足的历史待处理事项。
 */

import { api } from "../../helpers";
import type { WorkflowDeps } from "./types.js";

export function buildResearchHandlers(deps: WorkflowDeps) {
  const { state, openLogin } = deps as WorkflowDeps & { openLogin: () => void };
  const {
    product,
    activeTask,
    setLoading,
    setNotice,
    isVbkLoggedIn,
    resolvingVehicleTaskId,
    setResolvingVehicleTaskId,
    refreshingIssues,
    setRefreshingIssues,
    setActiveTaskId,
    verificationNote,
    setVerificationNote,
    setJustConfirmedTaskId,
    setProduct,
    setReadiness,
  } = state;

  /** 把运营填写的核查结果提交到 main 端，并触发一次 AI 续答以更新产品草稿。 */
  const confirmTask = async () => {
    if (!product || !activeTask) return;
    if (!verificationNote.trim()) {
      setNotice("请填写在 VBK 或公开来源查到的实际结果，再确认。");
      return;
    }

    setLoading(true);
    try {
      const confirmedId = activeTask.id;
      await api()!.research.accept(product.id, confirmedId, verificationNote.trim());
      await api()!.agent.send(
        product.id,
        `运营人员已完成「${activeTask.label}」核查，结果如下：${verificationNote.trim()}。请仅使用这段已核实信息更新产品草稿中对应字段；如仍缺少录入所需数据，请明确保留待核查项。`,
      );
      setVerificationNote("");
      setActiveTaskId(null);
      setJustConfirmedTaskId(confirmedId);
      window.setTimeout(() => {
        setJustConfirmedTaskId((current) => (current === confirmedId ? null : current));
      }, 1200);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法保存核查结果。");
    } finally {
      setLoading(false);
    }
  };

  /** 让 VBK 后端去匹配一个用车资源组；成功后刷新 readiness。 */
  const resolveVehicleTask = async () => {
    if (!product || !activeTask || resolvingVehicleTaskId) return;
    if (!isVbkLoggedIn) {
      openLogin();
      return;
    }

    setResolvingVehicleTaskId(activeTask.id);
    setNotice(null);
    state.setBrowserOpen(true);
    try {
      const result = await api()!.research.resolveVehicleResource(product.id, activeTask.id);
      if (!result) {
        setNotice("VBK 未返回可匹配的用车资源组，请调整全程用车总成本或关键词后重试。");
        return;
      }
      setNotice(`已匹配资源组：${result.resourceGroupName}（ID ${result.resourceGroupId}）。`);
      setVerificationNote("");
      setActiveTaskId(null);
      void state.updateReadiness(product);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "用车资源组匹配失败，请在 VBK 手动核查。");
    } finally {
      setResolvingVehicleTaskId(null);
    }
  };

  /** 重算并清理已由当前 product_json 满足的历史待处理事项。 */
  const refreshResearchIssues = async () => {
    if (!product || !api() || refreshingIssues) return;
    setRefreshingIssues(true);
    setNotice(null);
    try {
      const result = await api()!.research.refreshIssues(product.id);
      setProduct(result.product);
      state.setReadiness(result.readiness);
      setActiveTaskId(null);
      setVerificationNote("");
      setNotice(result.updated > 0 ? `已刷新待处理事项，清理 ${result.updated} 项。` : "已刷新待处理事项，暂无可自动清理项。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "刷新待处理事项失败。");
    } finally {
      setRefreshingIssues(false);
    }
  };

  return { confirmTask, resolveVehicleTask, refreshResearchIssues };
}