/**
 * vbk.tsx 左半屏：审查结果汇总 + 自动录入进度 + 阶段入口 / 重试按钮 +
 * readiness hero + footer（停止 / 已保存 / 前往方案确认）。
 *
 * 子组件：
 *   - ReviewHeroBlock          ：readiness hero（图标 + 文案 + 完成度）；
 *   - AutomationStagesList     ：阶段列表 + 进入 / 重试按钮组 + trafficLine 进度 + recovery banner；
 *   - ReviewFooter             ：停止 / 已保存草稿 / 前往方案确认按钮 + 文案状态。
 *
 * 由 vbk.tsx 直接传入 AppModel 切片。
 */

import { CheckCircle2, CircleHelp, LoaderCircle, Play, RefreshCw, ShieldCheck, Square, Wrench } from "lucide-react";
import { useMemo } from "react";
import { aggregateSectionState, phaseDisplayLabel, visibleVbkNavSections } from "../../../helpers";
import { TrafficLineProgress } from "../../../helpers/traffic-line-progress";
import { trafficResourceStatus } from "../../../../../shared/traffic-resource-status.js";
import type { TrafficLineConfig } from "../../../../../shared/contracts-traffic-line.js";
import shared from "../../shared.module.less";
import layout from "../layout.module.less";
import styles from "../vbk.module.less";
import type { AppModel } from "../../../app.main.model";

export interface ReviewAsideProps {
  model: AppModel;
}

export function AppWorkspaceVbkReview({ model }: ReviewAsideProps) {
  const {
    product,
    loading,
    readiness,
    automationActive,
    stoppingAutomation,
    stopAutomation,
    startAutomation,
    navigatingSection,
    retryingPhase,
    openSection,
    retryOnePhaseAutomation,
    automationPhases,
    automationRecovery,
    recoveryBlocked,
    advisorHint,
  } = model;

  const reviewSections = useMemo(
    () => visibleVbkNavSections(product).map((section) => ({
      section,
      state: aggregateSectionState(
        section,
        automationPhases ?? [],
        automationRecovery ?? {},
        product?.productId,
        product?.automation?.currentPhase,
      ),
      url: product ? section.buildUrl(product.productId) : null,
    })),
    [product, automationRecovery, automationPhases],
  );

  if (!product) return null;
  const draftSaved = product.status === "draft_saved" && Boolean(product.productId) && Boolean(product.automation?.phases.some(phase => phase.phase === "preflight" && phase.status === "completed"));
  const optionalTrafficPending = trafficResourceStatus(
    (product.product.operations as { trafficLine?: TrafficLineConfig } | undefined)?.trafficLine,
    product.automation?.trafficLine,
  ).hasIncompleteTraffic;
  const automationSucceeded = draftSaved;

  return (
    <aside className={`${layout.panel} ${styles.reviewSummary}`} aria-label="审查结果与 VBK 录入">
      <div className={layout.panelHeader}>
        <div className={layout.panelTitleRow}>
          <strong className={layout.panelTitle}>审查结果汇总</strong>
        </div>
      </div>
      <div className={styles.productScroll}>
        <div className={`${styles.readinessHero} ${readiness.ready ? styles.ready : ""}`} data-ready={readiness.ready}>
          <div className={styles.readinessHeroIcon}>
            {readiness.ready ? <CheckCircle2 size={18} /> : <CircleHelp size={18} />}
          </div>
          <div className={styles.readinessHeroBody}>
            <strong>{draftSaved ? "产品草稿已保存" : readiness.ready ? "产品方案已就绪" : "先回到第一步完成核查"}</strong>
            <small>{draftSaved ? optionalTrafficPending ? "母产品已完成并通过回读；未完成的交通套餐可单独重试。" : "母产品及交通套餐已通过远端回读。" : readiness.ready ? "在方案协作中确认后，将自动录入 VBK。" : `还有 ${readiness.issues.length} 项未处理。`}</small>
          </div>
          <div className={styles.readinessHeroProgress}>
            <strong>{readiness.completion}%</strong>
            <small>就绪度</small>
          </div>
        </div>
        <section className={styles.productSection}>
          <div className={styles.productSectionHead}>
            <span className={layout.panelNum}>C</span>
            <strong className={styles.productSectionTitle}>自动录入进度</strong>
            <span className={styles.productSectionMeta}>
              {draftSaved ? optionalTrafficPending ? "母产品已完成" : "全部完成" : product.automation?.currentPhase ? `当前：${product.automation.currentPhase}` : "未开始"}
            </span>
          </div>
          <div className={styles.automation}>
            {reviewSections.map(({ section, state, url }) => {
              const isNavigating = navigatingSection === section.key;
              const canNav = Boolean(url) && !loading && !navigatingSection && !retryingPhase;
              const saleControlRequiresNoProduct = section.key === "saleControl" && Boolean(product?.productId);
              const retryPhases = section.key === "saleControl" ? ["saleControl"] : section.phaseNames;
              return (
                <div key={section.key}>
                  <div className={styles.stage} data-state={state}>
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
                      {retryPhases.map((phaseKey) => {
                        // 单阶段重跑的 IPC 请求很快返回，而实际录入仍会在后台继续。
                        // 因此不能只看 retryingPhase；以持久化的当前阶段兜底，保证
                        // 「重新执行」图标在整段运行期间持续反馈，而非一闪即逝。
                        const isRetrying = retryingPhase === phaseKey
                          || (product.automation?.status === "running" && product.automation.currentPhase === phaseKey);
                        const phaseName = phaseDisplayLabel(phaseKey);
                        return (
                          <button
                            key={phaseKey}
                            type="button"
                            className={`${styles.stageAction} ${styles.stageActionRetry}`}
                            onClick={() => void retryOnePhaseAutomation(section.key, phaseKey)}
                            disabled={!!retryingPhase || !url || isNavigating || automationActive || saleControlRequiresNoProduct}
                            data-busy={isRetrying}
                            aria-label={`重新执行「${section.label}」的「${phaseName}」`}
                            title={`仅重跑 ${phaseName}，不影响其他阶段`}
                          >
                            <span>{isRetrying ? <LoaderCircle size={12} className={styles.stageActionSpinner} /> : <RefreshCw size={12} />}</span>
                            <span>{`重新执行${section.phaseNames.length > 1 ? ` ${phaseName}` : ""}`}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  {section.key === "trafficLine" ? <TrafficLineProgress automation={product.automation} product={product.product} /> : null}
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
      </div>
      <footer className={styles.productFooter}>
        <div className={styles.productFooterActions}>
          {automationActive ? (
            <button
              className={`${shared.btn} ${shared.btnLg}`}
              data-variant="danger"
              data-busy={stoppingAutomation}
              onClick={() => void stopAutomation()}
              disabled={stoppingAutomation}
              aria-label="停止自动录入"
              title="停止当前自动录入"
            >
              {stoppingAutomation ? <LoaderCircle size={15} /> : <Square size={15} />}
              停止自动录入
            </button>
          ) : automationSucceeded ? (
            <button
              className={`${shared.btn} ${shared.btnLg}`}
              data-variant="primary"
              disabled
              aria-label="草稿已保存到 VBK"
              title="草稿已保存到 VBK"
            >
              <CheckCircle2 size={15} />
              已保存草稿
            </button>
          ) : (
            <button
              className={`${shared.btn} ${shared.btnLg}`}
              data-variant="primary"
              onClick={() => {
                void startAutomation();
              }}
              disabled={loading}
              aria-label="前往方案确认"
              title="前往方案确认"
            >
              <Play size={15} />
              前往方案确认
            </button>
          )}
        </div>
        <span className={styles.productFooterMeta}>
          <strong>{automationSucceeded ? "已录入" : readiness.ready ? "✓ 已通过" : "⏳ 进行中"}</strong>
          {automationSucceeded ? " 草稿已保存到 VBK" : readiness.ready ? " 等待最终确认" : ` 还需 ${readiness.issues.length} 项核查`}
        </span>
      </footer>
    </aside>
  );
}

// vbkStageStatus is consumed by the parent barrel; declared here for type-narrowing tests
// but locally unused — silence the unused-binding warning via a void cast.
void ({ vbkStageStatus: undefined } as { vbkStageStatus?: unknown });