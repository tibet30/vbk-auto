import { ChevronRight, LoaderCircle, Play, Square } from "lucide-react";
import type { AppModel } from "../../app.main.model";
import { statusLabel } from "../../helpers";
import shared from "../shared.module.less";
import { AccountPopover } from "./AccountPopover";
import styles from "./Topbar.module.less";

/**
 * 44px 顶栏：项目面包屑 / 当前步骤状态 / 保存草稿按钮 / 账号菜单。
 * 不渲染主导航 stage-nav，那由 AppShell 直接负责。
 */
export function AppTopbar({ model }: { model: AppModel }) {
  const {
    view,
    project,
    setProject,
    setView,
    setAccountMenuOpen,
    accountMenuOpen,
    setNotice,
    readiness,
    stage,
    loading,
    automationActive,
    stoppingAutomation,
    currentAccountName,
    accountInitial,
    vbkLogin,
    saveDraftLabel,
    startAutomation,
    stopAutomation,
    openLogin,
    logoutVbk,
    checkingVbkLogin,
  } = model;

  const showProjectTools = Boolean(project) && view === "workspace";

  // 非工作台视图下，顶栏左侧显示当前页面名，比写死"VBK Desktop"更符合 macOS
  // 顶栏语义（顶栏 = 当前文档/视图名）。工作台视图下保持原项目面包屑。
  const viewTitle = view === "settings" ? "设置" : view === "operation-log" ? "操作日志" : view === "projects" ? "项目" : null;

  return (
    <header className={styles.topbar}>
      <nav className={styles.topbarTitle} aria-label="项目导航">
        {project ? (
          <>
            <button
              className={`${styles.crumb} ${styles.crumbAction}`}
              onClick={() => {
                setProject(null);
                setView("projects");
                setAccountMenuOpen(false);
              }}
              aria-label="返回项目列表"
            >
              <span>项目</span>
            </button>
            <ChevronRight size={13} className={styles.crumbSep} aria-hidden="true" />
            <span
              className={styles.crumbCurrent}
              data-form={project.name.endsWith("跟团游") ? "groupTour" : "privateTour"}
            >
              <strong className={styles.title}>{project.name}</strong>
              <span className={styles.crumbState} data-state={statusTone(project.status)}>
                <span className={shared.dot} data-state={project.status === "blocked" ? "warn" : project.status === "draft_saved" ? "ok" : "ai"} />
                {statusLabel(project.status)}
              </span>
            </span>
          </>
        ) : viewTitle ? (
          <span className={styles.crumb}>{viewTitle}</span>
        ) : (
          <span className={styles.crumb}>VBK Desktop</span>
        )}
      </nav>

      <div className={styles.topbarSpacer} />

      {showProjectTools && (
        <>
          <div className={styles.topbarStatusChip} aria-label="方案就绪状态">
            <span
              className={shared.dot}
              data-state={readiness.ready ? "ok" : readiness.issues.length ? "warn" : "ai"}
            />
            <strong>{readiness.completion}%</strong>
            <small>·</small>
            <small>
              {readiness.ready
                ? "可以录入 VBK"
                : `${readiness.issues.length} 项待处理`}
            </small>
          </div>

          <div className={styles.topbarToolRail}>
            <button
              className={`${shared.btn} ${shared.btnSm}`}
              data-variant="primary"
              disabled={!readiness.ready || loading || automationActive}
              onClick={() => {
                setNotice(null);
                if (stage !== "vbk") model.setStage("vbk");
                void startAutomation();
              }}
              aria-label={saveDraftLabel}
              title={saveDraftLabel}
            >
              {automationActive ? <LoaderCircle size={14} /> : <Play size={14} />}
              {saveDraftLabel}
            </button>

            {automationActive && (
              <button
                className={`${shared.btn} ${shared.btnSm}`}
                data-variant="danger"
                onClick={() => void stopAutomation()}
                disabled={stoppingAutomation}
                aria-label="停止自动录入"
                title="停止当前自动录入"
              >
                {stoppingAutomation ? <LoaderCircle size={14} /> : <Square size={14} />}
                停止
              </button>
            )}

            <button
              className={styles.topbarAccountChip}
              type="button"
              onClick={() => setAccountMenuOpen((open) => !open)}
              aria-label={`当前 VBK 账号：${currentAccountName}`}
              title={currentAccountName}
            >
              <span className={styles.topbarAccountMain}>
                <span className={styles.topbarAccountName}>{currentAccountName}</span>
                <span className={shared.dot} data-state={vbkLogin?.loggedIn ? "ok" : "warn"} />
              </span>
            </button>
          </div>
        </>
      )}

      {!project && (
        <div className={styles.topbarStatus}>
          <button
            className={styles.topbarAccountChip}
            type="button"
            onClick={() => setAccountMenuOpen((open) => !open)}
            aria-label={`当前 VBK 账号：${currentAccountName}`}
            title={currentAccountName}
          >
            <span className={styles.topbarAccountMain}>
              <span className={styles.topbarAccountName}>{currentAccountName}</span>
              <span className={shared.dot} data-state={vbkLogin?.loggedIn ? "ok" : "warn"} />
            </span>
          </button>

          {accountMenuOpen && (
            <AccountPopover
              currentAccountName={currentAccountName}
              accountInitial={accountInitial}
              onSwitchLogin={() => {
                setAccountMenuOpen(false);
                openLogin();
              }}
              onLogout={() => void logoutVbk()}
              vbkLoggedIn={Boolean(vbkLogin?.loggedIn)}
              logoutDisabled={checkingVbkLogin}
            />
          )}
        </div>
      )}
    </header>
  );
}

function statusTone(status: string): string {
  if (status === "blocked") return "warn";
  if (status === "draft_saved") return "ok";
  return "ai";
}
