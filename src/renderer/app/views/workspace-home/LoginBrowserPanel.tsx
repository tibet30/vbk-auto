import { RefreshCw, X } from "lucide-react";
import type { AppModel } from "../../app.main.model";
import { formatBrowserPath } from "../../helpers";
import shared from "../shared.module.less";
import styles from "./login-browser.module.less";

/**
 * 无项目工作台上的专用 VBK 登录 WebView surface（专用 login stage 右侧）。
 *
 * 设计动机：模块化重构后，view=workspace 且 project=null 时 ActiveRoute 走
 * AppWorkspaceHomePage，原 vbk 工作台里的 <div ref={browserRef}> 不存在 →
 * derived.ts 的 useLayoutEffect 拿不到 ref → 浏览器永远不可见、bounds 永远
 * 没被下发。这是「新增登录 / 登录 VBK」点了之后右侧看不见 VBK 页面的根因之一。
 *
 * 挂载契约：本组件只在父级 loginPanelOpen=true 时挂载，挂载期间始终渲染真实
 * viewport（持续持有 browserRef）。关闭时由父级直接把 loginPanelOpen 置 false
 * 卸载本组件，避免 DOM ref 消失而 main 进程仍显示造成幽灵浏览器。
 */
export function LoginBrowserPanel({ model }: { model: AppModel }) {
  const {
    browserRef,
    browserUrl,
    setBrowserOpen,
    setLoginPanelOpen,
    checkVbkLogin,
    vbkLogin,
    checkingVbkLogin,
  } = model;

  const handleClose = () => {
    setBrowserOpen(false);
    setLoginPanelOpen(false);
  };

  return (
    <section className={styles.panel} aria-label="VBK 登录">
      <div className={styles.panelHeader}>
        <div className={styles.panelTitleRow}>
          <span className={styles.panelNum}>02</span>
          <strong className={styles.panelTitle}>VBK 登录</strong>
        </div>
        <span className={`${styles.panelSubLine} ${vbkLogin?.loggedIn ? styles.panelSubLineOk : styles.panelSubLineWarn}`}>
          <span className={shared.dot} data-state={vbkLogin?.loggedIn ? "ok" : "warn"} />
          {vbkLogin?.loggedIn ? `已登录 ${vbkLogin.accountName ?? "当前账号"}` : "未登录 VBK"}
        </span>
      </div>
      <div className={styles.panelHead}>
        <div className={styles.url} title={browserUrl || "/产品库"}>
          <span className={styles.host}>vbooking.ctrip.com</span>
          <span className={styles.path}>{browserUrl ? formatBrowserPath(browserUrl) : "/产品库"}</span>
        </div>
        <div className={styles.actions}>
          <button
            className={`${shared.iconBtn} ${checkingVbkLogin ? styles.actionLoading : ""}`}
            type="button"
            data-size="sm"
            onClick={() => void checkVbkLogin(true)}
            disabled={checkingVbkLogin}
            aria-label="刷新状态"
            aria-busy={checkingVbkLogin}
            title="重新探测 VBK 登录态"
          >
            <RefreshCw size={14} className={checkingVbkLogin ? styles.spin : undefined} />
          </button>
          <button
            className={shared.iconBtn}
            type="button"
            data-size="sm"
            onClick={handleClose}
            aria-label="关闭登录面板"
            title="关闭登录面板"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div
        className={styles.viewport}
        ref={browserRef}
        data-testid="login-browser-viewport"
      />
    </section>
  );
}