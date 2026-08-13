import { Check, CircleHelp, LoaderCircle, Sparkles } from "lucide-react";
import type { AppModel } from "../../app.main.model";
import shared from "../shared.module.less";
import styles from "./StageNav.module.less";

/**
 * 两步工作流导航。仅在打开产品时渲染；切换 stage 由调用方决定。
 * 这里只负责呈现当前 stage 状态、概要文案和点击切换。
 */
export function AppStageNav({ model }: { model: AppModel }) {
  const { product, stage, openStage, reviewStepStatus, vbkStageStatus, productCompletionLabel } = model;

  if (!product) return null;

  return (
    <nav className={styles.stageNav} role="tablist" aria-label="产品工作流步骤">
      <button
        type="button"
        role="tab"
        id="stage-review"
        aria-controls="stage-panel-review"
        aria-selected={stage === "review"}
        tabIndex={stage === "review" ? 0 : -1}
        className={styles.stageStep}
        data-active={stage === "review"}
        data-status={reviewStepStatus}
        onClick={() => openStage("review")}
      >
        <span className={styles.stageStepIndex} aria-hidden="true">1</span>
        <span className={styles.stageStepBody}>
          <span className={styles.stageStepTitle}>AI 对话与产品审查</span>
          <span className={styles.stageStepStatus} aria-live="polite">
            {!product
              ? "选择产品后开始"
              : reviewStepStatus === "passed"
                ? `就绪 ${model.readiness.completion}% · 可以进入录入`
                : reviewStepStatus === "reviewing"
                  ? `${model.readiness.completion}% · 等待 AI 回复`
                  : `还差 ${model.readiness.issues.length} 项 · 尚未就绪`}
          </span>
        </span>
        <span
          className={`${styles.stageStepDot} ${shared.dot}`}
          data-state={
            reviewStepStatus === "passed"
              ? "ok"
              : reviewStepStatus === "inProgress"
                ? "warn"
                : reviewStepStatus === "reviewing"
                  ? "ai"
                  : "idle"
          }
          aria-hidden="true"
        />
      </button>

      <span
        className={styles.stageConnector}
        aria-hidden="true"
        data-state={
          reviewStepStatus === "passed"
            ? "ok"
            : reviewStepStatus === "inProgress"
              ? "warn"
              : "idle"
        }
      />

      <button
        type="button"
        role="tab"
        id="stage-vbk"
        aria-controls="stage-panel-vbk"
        aria-selected={stage === "vbk"}
        tabIndex={stage === "vbk" ? 0 : -1}
        className={styles.stageStep}
        data-active={stage === "vbk"}
        data-status={model.vbkStepStatus}
        onClick={() => openStage("vbk")}
      >
        <span className={styles.stageStepIndex} aria-hidden="true">2</span>
        <span className={styles.stageStepBody}>
          <span className={styles.stageStepTitle}>审查结果与 VBK 录入</span>
          <span className={styles.stageStepStatus} aria-live="polite">
            {vbkStageStatus.label} · {vbkStageStatus.detail}
          </span>
        </span>
        <span
          className={`${styles.stageStepDot} ${shared.dot}`}
          data-state={
            vbkStageStatus.tone === "saved"
              ? "ok"
              : vbkStageStatus.tone === "running"
                ? "ai"
                : reviewStepStatus === "passed"
                  ? "ready"
                  : "idle"
          }
          aria-hidden="true"
        />
      </button>

      <span className={styles.stageNavSpacer} aria-hidden="true" />
      <span className={styles.stageNavSummary} aria-label="当前步骤概要">
        {stage === "review" ? (
          <>
            <Sparkles size={14} />
            <span>{productCompletionLabel}</span>
          </>
        ) : (
          <>
            {vbkStageStatus.tone === "saved" ? (
              <Check size={14} />
            ) : vbkStageStatus.tone === "running" ? (
              <LoaderCircle size={14} />
            ) : (
              <CircleHelp size={14} />
            )}
            <span>{vbkStageStatus.label}</span>
          </>
        )}
      </span>
    </nav>
  );
}
