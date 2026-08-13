import { api, initialInput, phaseDisplayLabel, type VbkNavSection } from "../helpers";
import { APP_NAME } from "../brand";
import type { AppState } from "../state/useAppState";

/**
 * 汇总 workspace 工作流所需的所有 action（research 核查、自动化控制、VBK 浏览器交互、登录等）。
 * 渲染层从 useWorkflowHandlers() 拿到这些 handler 即可，不需要关心 IPC / 状态拼装细节。
 *
 * 现有 action 大致分类：
 *  - 核查与确认：confirmTask / resolveVehicleTask
 *  - 自动化控制：startAutomation / stopAutomation / retryOnePhaseAutomation
 *  - VBK 浏览器导航：openSection / showVbkBrowser
 *  - 多账号登录：openLogin / addNewLogin / switchAccount / forgetAccount / logoutVbk
 *  - 路由与产品视图切换：openProductList / startCreateProduct / openStage
 */

export function useWorkflowHandlers(state: AppState) {
  const {
    product,
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
    refreshingIssues,
    setRefreshingIssues,
    setActiveTaskId,
    verificationNote,
    setVerificationNote,
    setJustConfirmedTaskId,
    checkVbkLogin,
    setLoginPanelOpen,
    setVbkLogin,
    setAccountMenuOpen,
    setProduct,
    setView,
    setCreating,
    setCreateInput,
    setCheckingVbkLogin,
    refreshVbkLoginAccounts,
    setVbkLoginAccounts,
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
      await api()!.ai.send(
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
    setBrowserOpen(true);
    try {
      const result = await api()!.research.resolveVehicleResource(product.id, activeTask.id);
      if (!result) {
        setNotice("VBK 未返回可匹配的用车资源组，请调整建议日价或关键词后重试。");
        return;
      }
      setNotice(`已匹配资源组：${result.resourceGroupName}（ID ${result.resourceGroupId}）。`);
      setVerificationNote("");
      setActiveTaskId(null);
      void updateReadiness(product);
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

  /** 启动自动录入；切到 vbk 阶段并打开浏览器面板。 */
  const startAutomation = async () => {
    if (!product || !readiness.ready) return;
    setStage("vbk");
    setNotice(null);
    setBrowserOpen(true);
    setLoading(true);
    try {
      await api()!.automation.start(product.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "自动录入失败，可在 VBK 中检查后重试。");
    } finally {
      setLoading(false);
    }
  };

  /** 发送停止信号；当前 in-flight 阶段会自然结束后停止后续阶段。 */
  const stopAutomation = async () => {
    if (!product || !api() || stoppingAutomation) return;
    setStoppingAutomation(true);
    setNotice(null);
    try {
      await api()!.automation.stop(product.id);
      setNotice("已发送停止信号，当前阶段完成后将中止自动录入。" );
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
      await api()!.automation.retryOnePhase(product.id, phaseName);
      setNotice(`已重新执行：${phaseDisplayLabel(phaseName)}。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "重新执行失败，请在 VBK 中检查后重试。");
    } finally {
      setRetryingPhase(null);
    }
  };

  /**
   * 首次或未登录场景下打开 VBK 登录页。
   * 与"新增登录"区别：当前没人在用浏览器 → 不需要保存快照，只需要展示
   * VBK 登录入口。沿用旧 `browser.login()` 行为，导航到产品库让 VBK 自己
   * 在未登录时重定向到登录页。
   *
   * 失败语义：catch 必须 setNotice 把错误显式抛给用户看，并保留 login surface
   * （不动 loginPanelOpen / browserOpen / setVbkLogin(false)），让用户能在右侧
   * 看到失败提示后继续重试或重新打开。
   */
  const openLogin = () => {
    // setView 必须先于 setLoginPanelOpen：否则路由还在 settings 时 loginPanelOpen 已被置 true，
    // ActiveRoute 还停在 AppSettingsPage，<LoginBrowserPanel> 没机会挂载。
    setView("workspace");
    setStage("vbk");
    setBrowserOpen(true);
    setVbkLogin(null);
    setAccountMenuOpen(false);
    setLoginPanelOpen(true);
    if (api()) {
      api()!.browser.login()
        .then(() => checkVbkLogin())
        .catch((error) => {
          const message = error instanceof Error ? error.message : "无法打开 VBK 登录页面。";
          setNotice(`VBK 登录页打开失败：${message}。请稍后重试，或在右侧重新发起。`);
        });
    }
    void refreshVbkLoginAccounts();
  };

  /**
   * 「新增登录」专用入口。
   * 流程：
   *  1. 切到 workspace view 并把右侧 VBK WebView 设为可见、stage=vbk、loginPanelOpen=true；
   *     setView 必须先于 setLoginPanelOpen，否则设置页的路由切换会先于 login surface 挂载。
   *  2. 清空 stale vbkLogin.loggedIn：避免 derived.ts 中「已登录且 loginPanelOpen 则自动收起」
   *     effect 立刻把刚打开的登录面板关掉。
   *  3. 调 main 进程 addLogin()：保存当前账号 cookies、清空 session、导航到 VBK 根；
   *  4. 主动拉一次账号列表，让「已记录账号」立刻多出来一颗新 chip；
   *  5. 等用户在右侧完成登录后，checkVbkLogin 会被 status 流触发，
   *     自然把新账号 cookies 也写回 login_sessions。
   */
  const addNewLogin = async () => {
    if (!api()) return;
    setAccountMenuOpen(false);
    setView("workspace");
    setStage("vbk");
    setBrowserOpen(true);
    setVbkLogin(null);
    setLoginPanelOpen(true);
    try {
      await api()!.browser.addLogin();
      await refreshVbkLoginAccounts();
      void checkVbkLogin();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "新增登录失败。");
    }
  };

  /**
   * 切换到本机已记录的某个 VBK 账号。
   * 1. 调 main 进程 switchAccount()：保存当前 → 回灌目标 cookies → 导航；
   * 2. 等几百毫秒让 VBK 完成页面重渲染，再 checkVbkLogin 拿到新探测结果；
   * 3. 刷新账号列表快照（current 应当切到目标，saved 列表里少一项）。
   */
  const switchAccount = async (accountKey: string) => {
    if (!api()) return;
    if (!accountKey) return;
    setAccountMenuOpen(false);
    setNotice(null);
    try {
      await api()!.browser.switchAccount(accountKey);
      await refreshVbkLoginAccounts();
      setVbkLogin(null);
      await checkVbkLogin(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "切换登录账号失败。");
    }
  };

  /**
   * 忘记（从本机删除）某个 VBK 账号快照。
   * 立刻刷新账号列表快照即可；目标账号若当前正在 WebView 里展示，
   * main 端会拒绝并抛错，UI 会通过 notice 提示。
   */
  const forgetAccount = async (accountKey: string) => {
    if (!api()) return;
    if (!accountKey) return;
    setNotice(null);
    try {
      await api()!.browser.forgetAccount(accountKey);
      await refreshVbkLoginAccounts();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "忘记账号失败。");
    }
  };

  /** 把右侧 VBK WebView 设为可见，并刷新一次登录状态探测。 */
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
          ? `登出功能已更新，请重启 ${APP_NAME} 后再试。`
          : message || "VBK 登出失败，请重试。",
      );
    } finally {
      setCheckingVbkLogin(false);
    }
  };

  /** 退出当前产品，回到产品列表页。 */
  const openProductList = () => {
    setProduct(null);
    setView("products");
    setCreating(false);
    setAccountMenuOpen(false);
  };

  /** 进入"新建产品"对话框（产品列表页 + 表单初始值）。 */
  const startCreateProduct = () => {
    setProduct(null);
    setView("products");
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
    refreshResearchIssues,
    resolveVehicleTask,
    startAutomation,
    stopAutomation,
    openSection,
    retryOnePhaseAutomation,
    openLogin,
    addNewLogin,
    switchAccount,
    forgetAccount,
    showVbkBrowser,
    logoutVbk,
    openProductList,
    startCreateProduct,
    openStage,
  };
}
