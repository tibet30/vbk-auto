import { ArrowRight, Check, ChevronRight, CircleAlert, Copy, Download, ExternalLink, FolderOpen, Info, LoaderCircle, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { copyText } from "../../helpers";
import { useAppUpdate } from "../../update/AppUpdateContext";
import { dialogTitle, diagnosticText, formatCheckedAt, presentUpdate } from "../../update/update-presentation";
import shared from "../shared.module.less";
import styles from "./UpdateDialog.module.less";

const TITLE_ID = "app-update-dialog-title";
const DESC_ID = "app-update-dialog-description";
/** 复制结果的提示保留时长；到点后回到「复制」常态。 */
const COPY_FEEDBACK_MS = 2000;
const COPY_LABELS = { idle: "复制", done: "已复制", failed: "复制失败" } as const;

/**
 * 「更新说明」弹窗：先讲清现在什么状态，再给出可照做的操作步骤。
 * 用原生 <dialog> 承载焦点陷阱与 Esc 语义，与仓库其它确认弹窗保持一致。
 */
export function UpdateDialog() {
  const { state, loading, busy, notice, dialogOpen, closeDialog, dismissNotice, check, download, openInstaller, showInstallerInFolder } = useAppUpdate();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const copyTimerRef = useRef<number | null>(null);
  const [copyState, setCopyState] = useState<keyof typeof COPY_LABELS>("idle");
  const view = presentUpdate(state, loading);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (dialogOpen) {
      if (!dialog.open) dialog.showModal();
      requestAnimationFrame(() => closeRef.current?.focus());
      return;
    }
    if (dialog.open) dialog.close();
    setCopyState("idle");
  }, [dialogOpen]);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
  }, []);

  const copyDiagnostics = async () => {
    // 成功与失败都要有可见结果：静默失败会让按钮看起来「点了没反应」。
    const ok = await copyText(diagnosticText(state));
    setCopyState(ok ? "done" : "failed");
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyState("idle"), COPY_FEEDBACK_MS);
  };

  const renderPrimary = () => {
    if (busy === "downloading") {
      return <button type="button" className={`${shared.btn} ${shared.btnSm}`} data-variant="primary" disabled><LoaderCircle size={14} className={styles.spin} />下载中…</button>;
    }
    if (view.primaryAction === "download") {
      return <button type="button" className={`${shared.btn} ${shared.btnSm}`} data-variant="primary" disabled={busy !== null} onClick={() => void download()}><Download size={14} />下载新版</button>;
    }
    if (view.primaryAction === "open_installer") {
      return <button type="button" className={`${shared.btn} ${shared.btnSm}`} data-variant="primary" disabled={busy !== null} onClick={() => void openInstaller()}><ExternalLink size={14} />打开安装包</button>;
    }
    if (view.primaryAction === "check") {
      return <button type="button" className={`${shared.btn} ${shared.btnSm}`} data-variant="primary" disabled={busy !== null || !state?.supported} onClick={() => void check()}>{busy === "checking" ? <LoaderCircle size={14} className={styles.spin} /> : <RefreshCw size={14} />}重新检查</button>;
    }
    return null;
  };

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-modal="true"
      aria-labelledby={TITLE_ID}
      aria-describedby={DESC_ID}
      onCancel={(event) => { event.preventDefault(); closeDialog(); }}
      onClose={closeDialog}
    >
      <div className={styles.panel}>
        <header className={styles.head}>
          <span className={styles.headIcon} data-tone={view.tone} aria-hidden="true">
            {view.tone === "error" ? <CircleAlert size={17} /> : view.tone === "ready" ? <Download size={17} /> : <ShieldCheck size={17} />}
          </span>
          <div className={styles.headText}>
            <h2 id={TITLE_ID}>{dialogTitle(view)}</h2>
            <p id={DESC_ID}>{view.summary}</p>
          </div>
          <button ref={closeRef} type="button" className={styles.close} onClick={closeDialog} aria-label="关闭更新说明">
            <X size={15} />
          </button>
        </header>

        <div className={styles.body}>
          {notice && (
            <div className={styles.notice} role="alert">
              <CircleAlert size={13} aria-hidden="true" />
              <span>{notice.text}</span>
              <button type="button" className={styles.noticeClose} onClick={dismissNotice} aria-label="忽略这条提示">
                <X size={12} />
              </button>
            </div>
          )}

          <div className={styles.versions}>
            <span className={styles.versionCell}>
              <small>当前版本</small>
              <strong>v{state?.currentVersion ?? "—"}</strong>
            </span>
            <ArrowRight size={15} className={styles.versionArrow} aria-hidden="true" />
            <span className={styles.versionCell} data-tone={view.tone}>
              <small>{state?.downloaded ? "已下载版本" : "服务器最新版本"}</small>
              <strong>{state?.availableVersion ? `v${state.availableVersion}` : "—"}</strong>
            </span>
          </div>

          {view.progress !== undefined && (
            <span className={styles.track} role="progressbar" aria-valuenow={view.progress} aria-valuemin={0} aria-valuemax={100} aria-label="更新下载进度">
              <span style={{ width: `${view.progress}%` }} />
            </span>
          )}

          {view.steps.length > 0 && (
            <ol className={styles.steps}>
              {view.steps.map((step) => <li key={step}><span aria-hidden="true" /><p>{step}</p></li>)}
            </ol>
          )}

          {view.advice && (
            <p className={styles.advice} data-tone={view.tone}>
              <Info size={13} aria-hidden="true" />
              {view.advice}
            </p>
          )}

          <details className={styles.details}>
            <summary>
              <ChevronRight size={13} className={styles.chevron} aria-hidden="true" />
              <span className={styles.detailsLabel}>诊断信息</span>
              {/* 复制入口放在折叠行里：不必先展开就能一键取走诊断文本。 */}
              <button
                type="button"
                className={styles.copyBtn}
                data-state={copyState}
                aria-label="复制诊断信息"
                title={copyState === "failed" ? "复制失败，可展开后手动选中下方内容" : "复制诊断信息"}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void copyDiagnostics();
                }}
              >
                {copyState === "done"
                  ? <Check size={12} aria-hidden="true" />
                  : copyState === "failed"
                    ? <CircleAlert size={12} aria-hidden="true" />
                    : <Copy size={12} aria-hidden="true" />}
                <span aria-live="polite">{COPY_LABELS[copyState]}</span>
              </button>
            </summary>
            <dl>
              <div><dt>最近检查</dt><dd>{formatCheckedAt(state?.checkedAt)}</dd></div>
              {view.reason && <div><dt>失败原因</dt><dd>{view.reason}</dd></div>}
              <div><dt>更新源</dt><dd className={styles.mono}>{state?.feedUrl || "未配置"}</dd></div>
              {state?.installerPath && <div><dt>安装包</dt><dd className={styles.mono}>{state.installerPath}</dd></div>}
              {state?.errorDetail && <div><dt>技术细节</dt><dd className={styles.mono}>{state.errorDetail}</dd></div>}
            </dl>
          </details>
        </div>

        <footer className={styles.foot}>
          {state?.downloaded && (
            <button type="button" className={`${shared.btn} ${shared.btnSm}`} data-variant="secondary" disabled={busy !== null} onClick={() => void showInstallerInFolder()}>
              <FolderOpen size={14} />在 Finder 中显示
            </button>
          )}
          <span className={styles.footSpacer} />
          <button type="button" className={`${shared.btn} ${shared.btnSm}`} onClick={closeDialog}>
            {busy === "downloading" ? "后台下载" : "关闭"}
          </button>
          {renderPrimary()}
        </footer>
      </div>
    </dialog>
  );
}
