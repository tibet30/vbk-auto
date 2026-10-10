/**
 * 自动化控制 + VBK 浏览器导航：
 *   - startAutomation：切到 review 阶段并提示运营先在左侧「方案协作」确认；
 *   - stopAutomation：发送停止信号；当前 in-flight 阶段会自然结束后停止
 *     后续阶段；
 *   - retryOnePhaseAutomation：单阶段重跑；trafficLine + 已保存母产品走
 *     automation.continueApproved；其它阶段让 Agent 在左侧展示修复方案；
 *   - openSection：在右侧 VBK WebView 打开某个导航区域（基本信息 / 行程 /
 *     价格库存 等）。
 */

import { api, phaseDisplayLabel, type VbkNavSection } from "../../helpers";
import type { WorkflowDeps } from "./types.js";

export function buildAutomationHandlers(deps: WorkflowDeps) {
  const { state } = deps;
  const {
    product,
    setStage,
    setNotice,
    setBrowserOpen,
    setBrowserUrl,
    navigatingSection,
    setNavigatingSection,
    retryingPhase,
    setRetryingPhase,
    stoppingAutomation,
    setStoppingAutomation,
  } = state;

  /** 启动自动录入；切到 vbk 阶段并打开浏览器面板。 */
  const startAutomation = async () => {
    if (!product) return;
    setStage("review");
    setNotice("请在左侧「方案协作」确认当前方案后开始录入。");
  };

  /** 发送停止信号；当前 in-flight 阶段会自然结束后停止后续阶段。 */
  const stopAutomation = async () => {
    if (!product || !api() || stoppingAutomation) return;
    setStoppingAutomation(true);
    setNotice(null);
    try {
      await api()!.agent.pause(product.id);
      setNotice("已发送停止信号，当前阶段完成后将中止自动录入。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "发送停止信号失败。");
    } finally {
      setStoppingAutomation(false);
    }
  };

  /** 在右侧 VBK WebView 打开某个导航区域（基本信息 / 行程 / 价格库存 等）。 */
  const openSection = async (section: VbkNavSection) => {
    if (!product || !api() || navigatingSection || retryingPhase) return;
    const url = section.buildUrl(product.productId);
    if (!url) {
      setNotice("该页面需要先创建产品草稿才能打开，请等待销售控制完成。");
      return;
    }

    setNotice(null);
    setNavigatingSection(section.key);
    setStage("vbk");
    setBrowserOpen(true);
    try {
      await api()!.browser.navigate(url);
      const current = await api()!.browser.currentUrl().catch(() => "");
      if (current) setBrowserUrl(current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法跳转到 VBK 页面，请检查浏览器登录状态。");
    } finally {
      setNavigatingSection(null);
    }
  };

  /** 单阶段重跑（不重启其他阶段）；常用于运营在 VBK 中调整后重新填某个阶段。 */
  const retryOnePhaseAutomation = async (sectionKey: string, phaseName: string) => {
    if (!product || !api() || navigatingSection || retryingPhase || state.automationActive) return;
    setNotice(null);
    setRetryingPhase(phaseName);
    try {
      // A verified parent draft can have only its optional traffic children
      // unfinished. Their work must resume through the confirmed workflow,
      // rather than creating another Agent conversation that cannot perform
      // the already-approved write.
      if (phaseName === "trafficLine" && product.status === "draft_saved") {
        await api()!.automation.continueApproved(product.id);
        setNotice("已继续执行已确认的交通子产品录入与最终回读。");
        return;
      }
      setStage("review");
      await api()!.agent.send(product.id, `请检查并修复${phaseDisplayLabel(phaseName)}阶段，先展示修复后的方案并请求最终确认，再继续录入。`);
      setNotice("已在方案协作中开始检查，请在左侧查看进展并确认方案。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "重新执行失败，请在 VBK 中检查后重试。");
    } finally {
      setRetryingPhase(null);
    }
  };

  return { startAutomation, stopAutomation, openSection, retryOnePhaseAutomation };
}