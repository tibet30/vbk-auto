import {
  AlertTriangle,
  ArchiveX,
  Check,
  ChevronRight,
  Clock3,
  ListChecks,
  LoaderCircle,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ProductWorkflowTask, ProductWorkflowTaskStatus } from "../../../../shared/contracts.js";
import type { AppModel } from "../../app.main.model";
import { formatUpdatedAt } from "../../helpers/constants";
import shared from "../shared.module.less";
import styles from "./index.module.less";

type TaskFilter = "all" | "active" | "attention" | "completed" | "abandoned";

const FILTERS: Array<{ key: TaskFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "active", label: "进行中" },
  { key: "attention", label: "需要处理" },
  { key: "completed", label: "已结束" },
  { key: "abandoned", label: "已废弃" },
];

export function AppTasksPage({ model }: { model: AppModel }) {
  const { workflowTasks, openWorkflowTask, abandonWorkflowTask } = model;
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [abandoningId, setAbandoningId] = useState<string | null>(null);
  const tasks = useMemo(() => workflowTasks.filter((task) => matchesFilter(task, filter)), [workflowTasks, filter]);
  const activeCount = workflowTasks.filter((task) => task.status === "queued" || task.status === "running").length;
  const abandon = async (task: ProductWorkflowTask) => {
    if (abandoningId) return;
    setAbandoningId(task.id);
    const abandoned = await abandonWorkflowTask(task);
    setAbandoningId(null);
    if (abandoned) setConfirmingId(null);
  };

  return (
    <section className={styles.tasksView}>
      <div className={styles.tasksContainer}>
        <header className={styles.tasksHead}>
          <div>
            <h1>任务中心</h1>
            <p className={shared.viewSub}>{workflowTasks.length} 个任务 · {activeCount ? `${activeCount} 个正在执行` : "当前没有运行中的任务"}</p>
          </div>
          <nav className={styles.filters} aria-label="筛选任务">
            {FILTERS.map((item) => (
              <button key={item.key} type="button" data-active={filter === item.key} aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>
                {item.label}
              </button>
            ))}
          </nav>
        </header>

        {tasks.length === 0 ? (
          <div className={styles.emptyState}>
            <ListChecks size={28} aria-hidden="true" />
            <h2>{workflowTasks.length ? "当前筛选下没有任务" : "还没有后台任务"}</h2>
            <p>在创建产品时选择“一键生成并录入携程”，任务会立即出现在这里。</p>
          </div>
        ) : (
          <ul className={styles.taskList} aria-label="后台任务列表">
            {tasks.map((task) => (
              <li key={task.id} data-confirming={confirmingId === task.id || undefined}>
                <div className={styles.taskRow}>
                  <button type="button" className={styles.taskOpen} onClick={() => void openWorkflowTask(task)} disabled={Boolean(abandoningId)}>
                    <TaskIcon status={task.status} />
                    <span className={styles.taskBody}>
                      <span className={styles.taskTitleLine}>
                        <strong>{task.productName}</strong>
                        <TaskBadge status={task.status} />
                      </span>
                      <span className={styles.taskMessage}>{task.message}</span>
                      {task.error && <span className={styles.taskError}>{task.error}</span>}
                      <span className={styles.progressTrack} role="progressbar" aria-label="任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={task.progress}>
                        <span style={{ transform: `scaleX(${task.progress / 100})` }} />
                      </span>
                      <span className={styles.taskMeta}>{stageLabel(task)} · {task.progress}% · 更新于 {formatUpdatedAt(task.updatedAt)}</span>
                    </span>
                    <span className={styles.openHint}>产品详情 <ChevronRight size={14} aria-hidden="true" /></span>
                  </button>
                  {task.status !== "abandoned" && (
                    <button
                      className={styles.abandonTrigger}
                      type="button"
                      onClick={() => setConfirmingId((id) => id === task.id ? null : task.id)}
                      disabled={Boolean(abandoningId)}
                      aria-label={`永久废弃任务：${task.productName}`}
                      title="永久废弃任务"
                    >
                      <ArchiveX size={14} aria-hidden="true" />
                      <span>废弃</span>
                    </button>
                  )}
                </div>
                {confirmingId === task.id && (
                  <div className={styles.abandonConfirm} role="group" aria-label={`确认永久废弃任务：${task.productName}`}>
                    <div>
                      <strong>永久废弃「{task.productName}」任务？</strong>
                      <small>{task.status === "queued" || task.status === "running"
                        ? "将请求安全停止后续执行并永久封存任务；已经写入携程的数据不会回滚，关联产品不会删除。"
                        : "任务将永久标记为已废弃且无法恢复；关联产品、携程草稿和历史执行记录不会删除。"}</small>
                    </div>
                    <div className={styles.abandonActions}>
                      <button className={`${shared.btn} ${shared.btnSm}`} type="button" onClick={() => setConfirmingId(null)} disabled={abandoningId === task.id}>取消</button>
                      <button className={`${shared.btn} ${shared.btnSm}`} data-variant="danger-solid" type="button" onClick={() => void abandon(task)} disabled={abandoningId === task.id}>
                        {abandoningId === task.id ? <LoaderCircle size={14} className={styles.abandonSpin} aria-hidden="true" /> : <ArchiveX size={14} aria-hidden="true" />}
                        {abandoningId === task.id ? "正在废弃…" : "确认永久废弃"}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function matchesFilter(task: ProductWorkflowTask, filter: TaskFilter): boolean {
  if (filter === "active") return task.status === "queued" || task.status === "running";
  if (filter === "attention") return task.status === "needs_attention" || task.status === "failed";
  if (filter === "completed") return task.status === "succeeded" || task.status === "cancelled";
  if (filter === "abandoned") return task.status === "abandoned";
  return true;
}

function stageLabel(task: ProductWorkflowTask): string {
  if (task.status === "abandoned") return "永久废弃";
  if (task.stage === "planning") return "方案规划";
  if (task.stage === "readiness") return "录入前核验";
  if (task.stage === "automation") return "携程录入";
  if (task.stage === "completed") return "全部完成";
  return "等待执行";
}

function TaskBadge({ status }: { status: ProductWorkflowTaskStatus }) {
  const labels: Record<ProductWorkflowTaskStatus, string> = {
    queued: "排队中", running: "进行中", needs_attention: "需要处理",
    succeeded: "已完成", failed: "执行失败", cancelled: "已取消", abandoned: "已废弃",
  };
  return <span className={styles.taskBadge} data-status={status}>{labels[status]}</span>;
}

function TaskIcon({ status }: { status: ProductWorkflowTaskStatus }) {
  const props = { size: 17, "aria-hidden": true } as const;
  if (status === "running") return <span className={styles.taskIcon} data-status={status}><LoaderCircle {...props} /></span>;
  if (status === "succeeded") return <span className={styles.taskIcon} data-status={status}><Check {...props} /></span>;
  if (status === "needs_attention") return <span className={styles.taskIcon} data-status={status}><AlertTriangle {...props} /></span>;
  if (status === "failed") return <span className={styles.taskIcon} data-status={status}><XCircle {...props} /></span>;
  if (status === "abandoned") return <span className={styles.taskIcon} data-status={status}><ArchiveX {...props} /></span>;
  return <span className={styles.taskIcon} data-status={status}><Clock3 {...props} /></span>;
}
