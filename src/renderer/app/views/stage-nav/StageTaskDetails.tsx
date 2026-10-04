import { useRef } from "react";
import { ChevronDown } from "lucide-react";
import type { AppModel } from "../../app.main.model";
import { WorkflowTaskStrip } from "../workflow-task/TaskStrip";
import { PlanningUsagePanel, usePlanningUsage } from "../workspace/planning-usage";
import styles from "./StageNav.module.less";

export function StageTaskDetails({ model, reviewLabel }: { model: AppModel; reviewLabel: string }) {
  const details = useRef<HTMLDetailsElement>(null);
  const { product, currentWorkflowTask: task, vbkStageStatus } = model;
  const usage = usePlanningUsage(product?.aiUsage);
  return <details className={styles.taskDetails} ref={details}>
    <summary>任务详情 <ChevronDown size={12} aria-hidden="true" /></summary>
    <div className={styles.detailsBody}>
      <p><span>方案审查：{reviewLabel}</span><span>VBK 录入：{vbkStageStatus.label} · {vbkStageStatus.detail}</span></p>
      <WorkflowTaskStrip task={task} statusId="workflow-task-details-status" detailed />
      {usage.visible && <p className={styles.usageLabel}>{usage.label}</p>}
      {usage.visible && product?.aiUsage && <PlanningUsagePanel aiUsage={product.aiUsage} recent={usage.recent} onClose={() => { if (details.current) details.current.open = false; }} />}
    </div>
  </details>;
}
