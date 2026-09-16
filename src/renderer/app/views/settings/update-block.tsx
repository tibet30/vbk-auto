import { ArrowRight, CircleAlert, Download, ExternalLink, FolderOpen, LoaderCircle, RefreshCw } from "lucide-react";
import { useAppUpdate } from "../../update/AppUpdateContext";
import { formatCheckedAt, presentUpdate } from "../../update/update-presentation";
import shared from "../shared.module.less";
import styles from "./update-block.module.less";

/**
 * 设置页的软件更新卡片。
 * 只承担「现在什么状态 + 最快的那一下操作」，完整步骤交给「更新说明」弹窗，
 * 状态本身与底部全局状态栏共用同一个数据源。
 */
export function UpdateBlock() {
  const { state, loading, busy, notice, check, download, openInstaller, showInstallerInFolder, openDialog } = useAppUpdate();
  const view = presentUpdate(state, loading);
  const canCheck = Boolean(state?.supported) && busy === null;

  return (
    <section className={styles.block} aria-labelledby="update-title">
      <div className={styles.heading}>
        <span className={styles.icon} data-tone={view.tone} aria-hidden="true">
          {busy === "checking" ? <LoaderCircle size={18} className={styles.spin} /> : <RefreshCw size={18} />}
        </span>
        <div className={styles.headingBody}>
          <h2 id="update-title">软件更新</h2>
          <p>从自有服务器获取新版本，下载后由你确认安装。</p>
        </div>
        <span className={styles.status} data-tone={view.tone}>{view.badge}</span>
      </div>

      <div className={styles.meta}>
        <span className={styles.metaCell}>
          <small>当前版本</small>
          <strong>v{state?.currentVersion ?? "—"}</strong>
        </span>
        <ArrowRight size={14} className={styles.metaArrow} aria-hidden="true" />
        <span className={styles.metaCell} data-tone={view.tone}>
          <small>{state?.downloaded ? "已下载" : "服务器最新"}</small>
          <strong>{state?.availableVersion ? `v${state.availableVersion}` : "—"}</strong>
        </span>
        <span className={styles.metaCell}>
          <small>最近检查</small>
          <strong>{formatCheckedAt(state?.checkedAt)}</strong>
        </span>
      </div>

      <p className={styles.summary} data-tone={view.tone} role="status" aria-live="polite">{view.summary}</p>
      {view.advice && <p className={styles.advice}><CircleAlert size={13} aria-hidden="true" />{view.advice}</p>}

      {view.progress !== undefined && (
        <span className={styles.track} role="progressbar" aria-valuenow={view.progress} aria-valuemin={0} aria-valuemax={100} aria-label="更新下载进度">
          <span style={{ width: `${view.progress}%` }} />
        </span>
      )}

      {notice && <p className={styles.advice} role="alert">{notice.text}</p>}

      <div className={styles.actions}>
        <div className={shared.btnRow}>
          <button type="button" className={`${shared.btn} ${shared.btnSm}`} onClick={() => void check()} disabled={!canCheck}>
            {busy === "checking" ? <LoaderCircle size={14} className={styles.spin} /> : <RefreshCw size={14} />}
            检查更新
          </button>

          {view.primaryAction === "download" && (
            <button type="button" className={`${shared.btn} ${shared.btnSm}`} data-variant="ai" disabled={busy !== null} onClick={() => void download()}>
              {busy === "downloading" ? <LoaderCircle size={14} className={styles.spin} /> : <Download size={14} />}
              下载新版
            </button>
          )}

          {view.primaryAction === "open_installer" && (
            <button type="button" className={`${shared.btn} ${shared.btnSm}`} data-variant="ai" disabled={busy !== null} onClick={() => void openInstaller()}>
              <ExternalLink size={14} />
              打开安装包
            </button>
          )}

          {state?.downloaded && (
            <button type="button" className={`${shared.btn} ${shared.btnSm}`} data-variant="secondary" disabled={busy !== null} onClick={() => void showInstallerInFolder()}>
              <FolderOpen size={14} />在文件夹中显示
            </button>
          )}

          <button type="button" className={`${shared.btn} ${shared.btnSm}`} data-variant="ghost" onClick={openDialog}>
            更新说明
          </button>
        </div>
      </div>
    </section>
  );
}
