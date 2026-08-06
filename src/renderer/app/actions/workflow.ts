import { api, initialInput, phaseDisplayLabel, type VbkNavSection } from "../helpers";
import type { AppState } from "../state/useAppState";

export function useWorkflowHandlers(state: AppState) {
  const {
    project,
    loading,
    activeTask,
    setLoading,
    setNotice,
    setBrowserOpen,
    setBrowserUrl,
    setStage,
    navigatingSection,
    setNavigatingSection,
    retryingPhase,
    setRetryingPhase,
    stoppingAutomation,
    setStoppingAutomation,
    readiness,
    updateReadiness,
    isVbkLoggedIn,
    resolvingVehicleTaskId,
    setResolvingVehicleTaskId,
    setActiveTaskId,
    verificationNote,
    setVerificationNote,
    setJustConfirmedTaskId,
    checkVbkLogin,
    setLoginPanelOpen,
    setVbkLogin,
    setAccountMenuOpen,
    setProject,
    setView,
    setCreating,
    setCreateInput,
    setCheckingVbkLogin,
  } = state;

  const confirmTask = async () => {
    if (!project || !activeTask) return;
    if (!verificationNote.trim()) {
      setNotice("请填写在 VBK 或公开来源查到的实际结果，再确认。");
      return;
    }

    setLoading(true);
    try {
      const confirmedId = activeTask.id;
      await api()!.research.accept(project.id, confirmedId, verificationNote.trim());
      await api()!.ai.send(
        project.id,
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

  const resolveVehicleTask = async () => {
    if (!project || !activeTask || resolvingVehicleTaskId) return;
    if (!isVbkLoggedIn) {
      openLogin();
      return;
    }

    setResolvingVehicleTaskId(activeTask.id);
    setNotice(null);
    setBrowserOpen(true);
    try {
      const result = await api()!.research.resolveVehicleResource(project.id, activeTask.id);
      setNotice(`已匹配资源组：${result.resourceGroupName}（ID ${result.resourceGroupId}），估算 ${result.dailyCost} 元/天。`);
      setVerificationNote("");
      setActiveTaskId(null);
      void updateReadiness(project);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "用车资源组匹配失败，请在 VBK 手动核查。");
    } finally {
      setResolvingVehicleTaskId(null);
    }
  };

  const startAutomation = async () => {
    if (!project || !readiness.ready) return;
    setStage("vbk");
    setNotice(null);
    setBrowserOpen(true);
    setLoading(true);
    try {
      await api()!.automation.start(project.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "自动录入失败，可在 VBK 中检查后重试。");
    } finally {
      setLoading(false);
    }
  };

  const stopAutomation = async () => {
    if (!project || !api() || stoppingAutomation) return;
    setStoppingAutomation(true);
    setNotice(null);
    try {
      await api()!.automation.stop(project.id);
      setNotice("已发送停止信号，当前阶段完成后将中止自动录入。" );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "发送停止信号失败。");
    } finally {
      setStoppingAutomation(false);
    }
  };

  const openSection = async (section: VbkNavSection) => {
    if (!project || !api() || navigatingSection || retryingPhase) return;
    const url = section.buildUrl(project.productId);
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

  const retryOnePhaseAutomation = async (sectionKey: string, phaseName: string) => {
    if (!project || !api() || navigatingSection || retryingPhase || state.automationActive) return;
    setNotice(null);
    setRetryingPhase(phaseName);
    try {
      await api()!.automation.retryOnePhase(project.id, phaseName);
      setNotice(`已重新执行：${phaseDisplayLabel(phaseName)}。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "重新执行失败，请在 VBK 中检查后重试。");
    } finally {
      setRetryingPhase(null);
    }
  };

  const openLogin = () => {
    setLoginPanelOpen(true);
    setView("workspace");
    setBrowserOpen(true);
    setVbkLogin(null);
    setAccountMenuOpen(false);
    setStage("vbk");
    if (api()) {
      api()!.browser.login()
        .then(() => checkVbkLogin())
        .catch((error) => setVbkLogin({ loggedIn: false, message: error instanceof Error ? error.message : "无法打开 VBK 登录页面。" }));
    }
  };

  const showVbkBrowser = () => {
    setStage("vbk");
    setBrowserOpen(true);
    setLoginPanelOpen(false);
    void checkVbkLogin(true);
  };

  const logoutVbk = async () => {
    if (!api()) return;
    setCheckingVbkLogin(true);
    setNotice(null);
    try {
      await api()!.browser.logout();
      setVbkLogin({ loggedIn: false, message: "已退出 VBK。" });
      setBrowserOpen(false);
      setLoginPanelOpen(false);
      setAccountMenuOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      setNotice(
        message.includes("No handler registered")
          ? "登出功能已更新，请重启 VBK Desktop 后再试。"
          : message || "VBK 登出失败，请重试。",
      );
    } finally {
      setCheckingVbkLogin(false);
    }
  };

  const openProductList = () => {
    setProject(null);
    setView("projects");
    setCreating(false);
    setAccountMenuOpen(false);
  };

  const startCreateProduct = () => {
    setProject(null);
    setView("projects");
    setCreating(true);
    setCreateInput(initialInput);
    setAccountMenuOpen(false);
  };

  const openStage = (next: "review" | "vbk") => {
    setStage(next);
    setAccountMenuOpen(false);
  };

  return {
    confirmTask,
    resolveVehicleTask,
    startAutomation,
    stopAutomation,
    openSection,
    retryOnePhaseAutomation,
    openLogin,
    showVbkBrowser,
    logoutVbk,
    openProductList,
    startCreateProduct,
    openStage,
  };
}
