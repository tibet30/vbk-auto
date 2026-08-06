import {
  CalendarDays,
  CheckCircle2,
  CircleHelp,
  LoaderCircle,
  MessageCircleMore,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Square,
  Wrench,
} from "lucide-react";
import { useMemo } from "react";
import {
  aggregateSectionState,
  formatBrowserPath,
  phaseDisplayLabel,
  VBK_NAV_SECTIONS,
} from "../../helpers";
import type { AppModel } from "../../app.main.model";
import shared from "../shared.module.less";
import layout from "./layout.module.less";
import browser from "./vbk.browser.module.less";
import tasks from "./vbk.tasks.module.less";
import styles from "./vbk.module.less";

export function AppWorkspaceVbk({ model }: { model: AppModel }) {
  const {
    project,
    splitStyle,
    loading,
    setStage,
    setBrowserOpen,
    setBrowserUrl,
    browserOpen,
    browserRef,
    browserUrl,
    setView,
    stage,
    navigatingSection,
    retryingPhase,
    openSection,
    retryOnePhaseAutomation,
    recoveryBlocked,
    advisorHint,
    vbkLogin,
    readiness,
    vbkStageStatus,
    automationActive,
    stoppingAutomation,
    stopAutomation,
    setActiveTaskId,
    activeTaskId,
    automationPhases,
    automationRecovery,
    browserPlaceholderTitle,
    browserPlaceholderText,
    setLoginPanelOpen,
    openLogin,
    showVbkBrowser,
  } = model;

  const taskList = project?.researchTasks ?? [];
  const reviewSections = useMemo(
    () => VBK_NAV_SECTIONS.map((section) => ({
      section,
      state: aggregateSectionState(section, automationPhases ?? [], automationRecovery ?? {}),
      url: project ? section.buildUrl(project.productId) : null,
    })),
    [project?.productId, automationRecovery, automationPhases],
  );

  if (!project) return null;

  return <div className={`${layout.stageSplit} ${styles.vbkSplit}`} style={splitStyle}>
    <aside className={`${layout.panel} ${styles.reviewSummary}`} aria-label="审查结果与 VBK 录入">
      <div className={layout.panelHeader}>
        <div className={layout.panelTitleRow}>
          <span className={layout.panelNum}>02</span>
          <strong className={layout.panelTitle}>审查结果汇总</strong>
        </div>
        <span className={shared.state} data-state={vbkStageStatus.tone}>{vbkStageStatus.label}</span>
      </div>
      <div className={styles.productScroll}>
        <div className={`${styles.readinessHero} ${readiness.ready ? styles.ready : ""}`} data-ready={readiness.ready}>
          <div className={styles.readinessHeroIcon}>
            {readiness.ready ? <CheckCircle2 size={18} /> : <CircleHelp size={18} />}
          </div>
          <div className={styles.readinessHeroBody}>
            <strong>{readiness.ready ? "产品方案已就绪" : "先回到第一步完成核查"}</strong>
            <small>{readiness.ready ? "切换至 VBK 录入后可开始保存草稿。" : `还有 ${readiness.issues.length} 项未处理。`}</small>
          </div>
          <div className={styles.readinessHeroProgress}>
            <strong>{readiness.completion}%</strong>
            <small>就绪度</small>
          </div>
        </div>
        {project.automation && (
          <section className={styles.productSection}>
            <div className={styles.productSectionHead}>
              <span className={layout.panelNum}>C</span>
              <strong className={styles.productSectionTitle}>自动录入进度</strong>
              <span className={styles.productSectionMeta}>
                {project.automation.currentPhase ? `当前：${project.automation.currentPhase}` : "未开始"}
              </span>
            </div>
            <div className={styles.automation}>
              {reviewSections.map(({ section, state, url }) => {
                const isNavigating = navigatingSection === section.key;
                const canNav = Boolean(url) && !loading && !navigatingSection && !retryingPhase;
                return (
                  <div className={styles.stage} key={section.key} data-state={state}>
                    <span className={styles.stageDot} />
                    <span className={styles.stageLabel}>{section.label}</span>
                    <div className={styles.stageActions}>
                      <button
                        type="button"
                        className={`${styles.stageAction} ${styles.stageActionEnter}`}
                        onClick={() => void openSection(section)}
                        disabled={!canNav}
                        data-busy={isNavigating}
                        aria-label={`进入「${section.label}」页面`}
                        title={url ? `在 VBK 中打开「${section.label}」` : "尚未生成 VBK 产品"}
                      >
                        <span>进入</span>
                        {isNavigating ? <LoaderCircle size={12} /> : <Wrench size={12} />}
                      </button>
                      {section.phaseNames.map((phaseKey) => {
                        const isRetrying = retryingPhase === phaseKey;
                        const phaseName = phaseDisplayLabel(phaseKey);
                        return (
                          <button
                            key={phaseKey}
                            type="button"
                            className={`${styles.stageAction} ${styles.stageActionRetry}`}
                            onClick={() => void retryOnePhaseAutomation(section.key, phaseKey)}
                            disabled={!!retryingPhase || !url || isNavigating}
                            data-busy={isRetrying}
                            aria-label={`重新执行「${section.label}」的「${phaseName}」`}
                            title={`仅重跑 ${phaseName}，不影响其他阶段`}
                          >
                            <span>{isRetrying ? <LoaderCircle size={12} /> : <RefreshCw size={12} />}</span>
                            <span>{`重新执行${section.phaseNames.length > 1 ? ` ${phaseName}` : ""}`}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              {recoveryBlocked && (
                <div className={styles.recoveryBanner} data-state="needs_user" role="alert" aria-live="assertive">
                  <ShieldCheck size={14} />
                  <span>{`已停止，等待处理：${recoveryBlocked.displayPhase}`}</span>
                </div>
              )}
              {advisorHint && (
                <div className={styles.recoveryBanner} data-state="advising" role="status" aria-live="polite">
                  <ShieldCheck size={14} />
                  <span>{`建议在 VBK 里重试「${advisorHint.displayPhase}」：第 ${advisorHint.currentAttempt} 次（${advisorHint.action === "advising" ? "AI 重试建议" : "手动重试"}）。`}</span>
                </div>
              )}
              <p className={styles.automationNote}>只保存草稿，不提交审核或发布。</p>
            </div>
          </section>
        )}
      </div>
      <footer className={styles.productFooter}>
        <span className={styles.productFooterMeta}>
          <strong>{readiness.ready ? "✓ 已通过" : "⏳ 进行中"}</strong>
          {readiness.ready ? " 可保存 VBK 草稿" : ` 还需 ${readiness.issues.length} 项核查`}
        </span>
        <div className={styles.productFooterActions}>
          {automationActive && (
            <button
              className={`${shared.btn} ${shared.btnLg}`}
              data-variant="danger"
              onClick={() => void stopAutomation()}
              disabled={stoppingAutomation}
            >
              {stoppingAutomation ? <LoaderCircle size={15} /> : <Square size={15} />}
              停止自动录入
            </button>
          )}
        </div>
      </footer>
    </aside>
    <section className={`${layout.panel} ${browser.browser}`} aria-label="VBK 浏览器">
      <div className={layout.panelHeader}>
        <div className={layout.panelTitleRow}>
          <span className={layout.panelNum}>03</span>
          <strong className={layout.panelTitle}>VBK 浏览器</strong>
        </div>
        <span className={`${layout.panelSubLine} ${vbkLogin?.loggedIn ? layout.panelSubLineOk : layout.panelSubLineWarn}`}>
          <span className={shared.dot} data-state={vbkLogin?.loggedIn ? "ok" : "warn"} />
          {vbkLogin?.loggedIn ? `已登录 ${vbkLogin.accountName ?? "当前账号"}` : "未登录 VBK"}
        </span>
      </div>
      <div className={browser.browserPanelHead}>
        <div className={browser.browserNav}>
          <button className={shared.iconBtn} type="button" data-size="sm" aria-label="返回" onClick={() => setView("workspace")}>
            <Settings2 size={14} />
          </button>
        </div>
        <div className={browser.browserUrl} title={browserUrl || "/产品库"}>
          <span className={browser.host}>vbooking.ctrip.com</span>
          <span className={browser.path}>{browserUrl ? formatBrowserPath(browserUrl) : "/产品库"}</span>
        </div>
        <div className={browser.browserActions}>
          <button className={shared.iconBtn} type="button" data-size="sm" onClick={() => setBrowserOpen(!browserOpen)} aria-label="显示/隐藏浏览器">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
      <div className={browser.browserViewport} ref={browserRef}>
        {!browserOpen ? (
          <div className={browser.browserPlaceholder}>
            <div className={browser.browserPlaceholderCard}>
              <MessageCircleMore size={22} />
              <h4>{browserPlaceholderTitle}</h4>
              <p>{browserPlaceholderText}</p>
              <div className={`${shared.btnRow}`}>
                {vbkLogin?.loggedIn ? (
                  <button className={shared.btn} data-variant="primary" onClick={showVbkBrowser}>
                    <MessageCircleMore size={15} /> 显示浏览器
                  </button>
                ) : (
                  <button className={shared.btn} data-variant="primary" onClick={() => openLogin()}>
                    <MessageCircleMore size={15} /> 登录 VBK
                  </button>
                )}
                <button className={shared.btn} data-variant="ghost" onClick={() => setLoginPanelOpen(false)}>
                  刷新状态
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {taskList.length ? (
          <div className={tasks.taskRail} data-empty={taskList.length === 0}>
            <div className={tasks.taskRailHead}>
              <strong><CalendarDays size={14} />待核查</strong>
              <small>{`${taskList.length} 项 · ${taskList.filter((task) => task.state === "confirmed" || task.state === "resolved").length} 已完成`}</small>
            </div>
            <div className={tasks.taskStrip}>
              {taskList.map((task) => (
                <button
                  key={task.id}
                  className={tasks.taskRowGrid}
                  onClick={() => setActiveTaskId(task.id)}
                  data-active={task.id === activeTaskId}
                  data-done={task.state === "confirmed" || task.state === "resolved"}
                >
                  <span className={tasks.marker}>
                    {task.state === "confirmed" || task.state === "resolved" ? <CheckCircle2 size={12} /> : <CircleHelp size={12} />}
                  </span>
                  <span className={tasks.body}>
                    <span className={tasks.label}>{task.label}</span>
                    <span className={tasks.detail}>{task.detail || "需要核查"}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  </div>;
}
