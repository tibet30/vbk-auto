import { CircleAlert, Download, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { useAppUpdate } from "../../update/AppUpdateContext";
import { presentUpdate, type UpdateTone } from "../../update/update-presentation";
import styles from "./StatusBar.module.less";

/**
 * 全局状态栏：常驻在窗口底部，登录与未登录都可见。
 * 左侧是软件更新标识，点击打开更新说明弹窗；右侧是版本与快速检查。
 */
export function AppStatusBar() {
  const { state, loading, busy, check, openDialog } = useAppUpdate();
  const view = presentUpdate(state, loading);
  const canCheck = Boolean(state?.supported) && busy === null;

  return (
    <footer className={styles.bar} aria-label="应用状态栏">
      <button
        type="button"
        className={styles.updateChip}
        data-tone={view.tone}
        onClick={openDialog}
        aria-haspopup="dialog"
        aria-label={`软件更新：${view.badge}。${view.summary} 点击查看更新说明。`}
        title={`${view.headline} · ${view.summary}`}
      >
        <UpdateGlyph tone={view.tone} attention={view.attention} />
        <span className={styles.chipText}>{view.headline}</span>
        <span className={styles.badge}>{view.badge}</span>
      </button>

      {view.progress !== undefined && (
        <>
          <span className={styles.track} role="progressbar" aria-valuenow={view.progress} aria-valuemin={0} aria-valuemax={100} aria-label="更新下载进度">
            <span style={{ width: `${view.progress}%` }} />
          </span>
          <span className={styles.trackLabel}>{view.progress}%</span>
        </>
      )}

      <span className={styles.spacer} />

      {state && <span className={styles.version}>v{state.currentVersion}</span>}

      <button
        type="button"
        className={styles.quietBtn}
        onClick={() => void check()}
        disabled={!canCheck}
        title={state?.supported ? "立即检查服务器上的新版本" : "只有打包后的 macOS 安装版支持在线更新"}
      >
        {busy === "checking" ? <LoaderCircle size={12} className={styles.spin} /> : <RefreshCw size={12} />}
        检查更新
      </button>
    </footer>
  );
}

function UpdateGlyph({ tone, attention }: { tone: UpdateTone; attention: boolean }) {
  if (attention) return <span className={styles.pulse} aria-hidden="true" />;
  if (tone === "busy") return <LoaderCircle size={12} className={`${styles.icon} ${styles.spin}`} aria-hidden="true" />;
  if (tone === "error") return <CircleAlert size={12} className={`${styles.icon} ${styles.iconError}`} aria-hidden="true" />;
  if (tone === "ready") return <Download size={12} className={`${styles.icon} ${styles.iconReady}`} aria-hidden="true" />;
  return <ShieldCheck size={12} className={`${styles.icon} ${styles.iconMuted}`} aria-hidden="true" />;
}
