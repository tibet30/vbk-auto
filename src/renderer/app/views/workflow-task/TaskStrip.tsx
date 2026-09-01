import { AlertTriangle, ArchiveX, Check, Clock3, LoaderCircle, XCircle } from "lucide-react";
import type { ProductWorkflowTask } from "../../../../shared/contracts.js";
import { formatUpdatedAt } from "../../helpers/constants";
import styles from "./TaskStrip.module.less";

export function WorkflowTaskStrip({ task }: { task: ProductWorkflowTask | null }) {
  if (!task) return null;
  const status = statusMeta(task);
  return (
    <section id="workflow-task-status" className={styles.taskStrip} data-status={task.status} aria-live="polite" tabIndex={-1}>
      <span className={styles.statusIcon} aria-hidden="true">{status.icon}</span>
      <span className={styles.taskCopy}>
        <span className={styles.titleLine}>
          <strong>{status.label}</strong>
          <span>{stageLabel(task)}</span>
        </span>
        <span className={styles.message}>{task.error || task.message}</span>
      </span>
      <span className={styles.progressBlock}>
        <span className={styles.progressMeta}><strong>{task.progress}%</strong><small>更新 {formatUpdatedAt(task.updatedAt)}</small></span>
        <span className={styles.progressTrack} role="progressbar" aria-label="后台任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={task.progress}><span style={{ transform: `scaleX(${task.progress / 100})` }} /></span>
      </span>
    </section>
  );
}

function stageLabel(task: ProductWorkflowTask): string {
  if (task.status === "abandoned") return "永久废弃";
  if (task.stage === "planning") return "方案规划";
  if (task.stage === "readiness") return "录入前核验";
  if (task.stage === "automation") return "携程录入";
  if (task.stage === "completed") return "全部完成";
  return "等待执行";
}

function statusMeta(task: ProductWorkflowTask) {
  const iconProps = { size: 15 };
  if (task.status === "running") return { label: "后台任务进行中", icon: <LoaderCircle {...iconProps} /> };
  if (task.status === "succeeded") return { label: "后台任务已完成", icon: <Check {...iconProps} /> };
  if (task.status === "needs_attention") return { label: "后台任务等待处理", icon: <AlertTriangle {...iconProps} /> };
  if (task.status === "failed") return { label: "后台任务执行失败", icon: <XCircle {...iconProps} /> };
  if (task.status === "cancelled") return { label: "后台任务已取消", icon: <XCircle {...iconProps} /> };
  if (task.status === "abandoned") return { label: "后台任务已废弃", icon: <ArchiveX {...iconProps} /> };
  return { label: "后台任务已排队", icon: <Clock3 {...iconProps} /> };
}
