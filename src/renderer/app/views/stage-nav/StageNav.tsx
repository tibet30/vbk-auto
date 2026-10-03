import { Check, CircleHelp, LoaderCircle, Sparkles } from "lucide-react";
import type { AppModel } from "../../app.main.model";
import { WorkflowTaskSummary } from "../workflow-task/TaskStrip";
import { StageTaskDetails } from "./StageTaskDetails";
import { formatCostLabel, formatTokens } from "../workspace/planning-usage-format";
import styles from "./StageNav.module.less";

/** Product stages and authoritative status share one compact toolbar. */
export function AppStageNav({ model }: { model: AppModel }) {
  const { product, stage, openStage, reviewStepStatus, vbkStageStatus, currentWorkflowTask } = model;
  if (!product) return null;
  const taskActive = currentWorkflowTask && currentWorkflowTask.status !== "succeeded";
  const saved = vbkStageStatus.tone === "saved";
  const usage = product.aiUsage?.lifetime;
  const usageCost = formatCostLabel(usage?.estimatedCostCny);
  const reviewLabel = reviewStepStatus === "passed"
    ? `就绪 ${model.readiness.completion}% · 可以进入录入`
    : reviewStepStatus === "reviewing"
      ? `${model.readiness.completion}% · 等待 AI 回复`
      : `还差 ${model.readiness.issues.length} 项 · 尚未就绪`;

  return <div className={styles.stageNav}>
    <div className={styles.toolbar}>
      <nav className={styles.stageTabs} role="tablist" aria-label="产品工作流步骤">
        {(["review", "vbk"] as const).map((step, index) => <button
          key={step}
          type="button"
          role="tab"
          id={`stage-${step}`}
          aria-controls={`stage-panel-${step}`}
          aria-selected={stage === step}
          className={styles.stageStep}
          data-active={stage === step}
          data-status={step === "review" ? reviewStepStatus : model.vbkStepStatus}
          title={step === "review" ? reviewLabel : `${vbkStageStatus.label} · ${vbkStageStatus.detail}`}
          onClick={() => openStage(step)}
        >
          <span className={styles.stageStepIndex} aria-hidden="true">{index + 1}</span>
          <span>{step === "review" ? "方案审查" : "VBK 录入"}</span>
          {step === "review" && !model.readiness.ready && model.readiness.issues.length > 0 && <span className={styles.stageIssueCount}>{model.readiness.issues.length} 项待处理</span>}
        </button>)}
      </nav>
      {usage && usage.calls > 0 && <span className={styles.usageMetric} aria-label="当前产品累计 AI 消耗" title="当前产品累计 Token 与人民币估算费用，明细见任务详情">
        <span>{usage.tokensIncomplete || usage.totalTokens === null ? "Token 未返回" : `${formatTokens(usage.totalTokens)} Token`}</span>
        {usageCost && <span>· {usageCost}</span>}
      </span>}
      <div id="workflow-task-status" className={styles.stageNavSummary} data-tone={taskActive ? currentWorkflowTask.status : vbkStageStatus.tone} role="status" aria-live="polite" tabIndex={-1}>
        {taskActive ? <WorkflowTaskSummary task={currentWorkflowTask} compact /> : <>
          {saved ? <Check size={14} /> : vbkStageStatus.tone === "running" ? <LoaderCircle size={14} /> : stage === "review" ? <Sparkles size={14} /> : <CircleHelp size={14} />}
          <span>{saved ? "草稿已保存 · 未发布" : stage === "review" ? model.productCompletionLabel : vbkStageStatus.label}</span>
        </>}
      </div>
      <StageTaskDetails key={product.id} model={model} reviewLabel={reviewLabel} />
    </div>
  </div>;
}
