/**
 * 多账号登录类 handler：
 *   - openLogin：首次或未登录场景下打开 VBK 登录页（login panel）；
 *   - addNewLogin：「新增登录」专用入口，保存当前账号 cookies 后清空 session
 *     让用户登录下一个账号；
 *   - switchAccount：切换到本机已记录的某个 VBK 账号；
 *   - forgetAccount：从本机删除某个 VBK 账号快照；
 *   - showVbkBrowser：把右侧 VBK WebView 设为可见，并刷新一次登录状态探测；
 *   - logoutVbk：退出 VBK 当前账号；保留本机其他账号快照。
 */

import { api } from "../../helpers";
import { APP_NAME } from "../../brand";
import type { WorkflowDeps } from "./types.js";

export function buildLoginHandlers(deps: WorkflowDeps) {
  const { state } = deps;
  const {
    setView,
    setStage,
    setBrowserOpen,
    setVbkLogin,
    setAccountMenuOpen,
    setLoginPanelOpen,
    setCheckingVbkLogin,
    setNotice,
    refreshVbkLoginAccounts,
    checkVbkLogin,
  } = state;

  /**
   * 首次或未登录场景下打开 VBK 登录页。
   * 与"新增登录"区别：当前没人在用浏览器 → 不需要保存快照，只需要展示
   * VBK 登录入口。
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
        .catch((error) => {
          const message = error instanceof Error ? error.message : "无法打开 VBK 登录页面。";
          setNotice(`VBK 登录页打开失败：${message}。请稍后重试，或在右侧重新发起。`);
        });
    }
    void refreshVbkLoginAccounts();
  };

  /**
   * 「新增登录」专用入口。
   *  1. 切到 workspace view 并把右侧 VBK WebView 设为可见、stage=vbk、loginPanelOpen=true；
   *     setView 必须先于 setLoginPanelOpen，否则设置页的路由切换会先于 login surface 挂载。
   *  2. 清空 stale vbkLogin.loggedIn：避免 derived.ts 中「已登录且 loginPanelOpen 则自动收起」
   *     effect 立刻把刚打开的登录面板关掉。
   *  3. 调 main 进程 addLogin()：保存当前账号 cookies、清空 session、导航到 VBK 根；
   *  4. 主动拉一次账号列表，让「已记录账号」立刻多出来一颗新 chip；
   *  5. 等用户在右侧完成登录后，由「我已完成 VBK 登录」按钮手动触发 status。
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

  return { openLogin, addNewLogin, switchAccount, forgetAccount, showVbkBrowser, logoutVbk };
}