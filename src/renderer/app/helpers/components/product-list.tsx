/**
 * ProductList / ProductRow / productMeta：
 *   - ProductList：列表容器，每个 ProductSummary 渲染为 ProductRow；
 *     内部维护 confirmingId / deletingId / resumingTaskId 三个本地态。
 *   - ProductRow：单行卡片，Open trigger / 状态徽章 / meta / 进度 / 重试 / 删除；
 *     locked = automating / queued / running 时禁用删除按钮。
 *   - productMeta：从产品名反解产品形态（groupTour / privateTour / 等）。
 *
 * 设计要点：
 *   - 还原 <button> 的键盘语义：Enter / Space 触发进入产品；
 *   - CopyableId 嵌套在 <button> 内是常见折中——避免和 productRowOpen click 冲突，
 *     CopyableId 通过 stopClickPropagation 阻止冒泡；
 *   - productMeta 是纯函数，可独立测试。
 */

import { Briefcase, Eye, LoaderCircle, RotateCcw, Trash2, Users } from "lucide-react";
import { useState } from "react";
import type { ProductSummary, WorkflowTaskRetryMode } from "../../../../shared/contracts.js";
import { PRODUCT_FORM_LABELS, type ProductForm } from "../../../../shared/product-form.js";
import styles from "../components.module.less";
import { formatUpdatedAt } from "../constants";
import { isProductSupersededByReplacement, ProductStatusBadge, productTaskStageLabel } from "../product-task-status";
import { useProductExecutionTimes } from "../../state/product-execution-time";
import { ProductExecutionTimeLabel } from "../product-execution-time-label";
import { CopyableId } from "./copyable-id";

export function ProductList({ products, onOpen, onDelete, onResumeTask }: {
  products: ProductSummary[];
  onOpen: (item: ProductSummary) => Promise<void>;
  onDelete: (item: ProductSummary) => Promise<boolean>;
  onResumeTask: (
    task: NonNullable<ProductSummary["workflowTask"]>,
    mode: WorkflowTaskRetryMode,
  ) => Promise<boolean>;
}) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const executionTimes = useProductExecutionTimes(products);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [resumingTaskId, setResumingTaskId] = useState<string | null>(null);
  const remove = async (item: ProductSummary) => {
    if (deletingId) return;
    setDeletingId(item.id);
    const removed = await onDelete(item);
    setDeletingId(null);
    if (removed) setConfirmingId(null);
  };
  const resume = async (item: ProductSummary, mode: WorkflowTaskRetryMode) => {
    const task = item.workflowTask;
    if (!task || resumingTaskId) return;
    setResumingTaskId(task.id);
    await onResumeTask(task, mode);
    setResumingTaskId(null);
  };

  return (
    <ul className={styles.productList} aria-label="产品列表">
      {products.map((item) => (
        <li className={styles.productListItem} key={item.id}>
          <ProductRow
            item={{ ...item, executionTime: executionTimes[item.id] }}
            disabled={Boolean(deletingId) || Boolean(resumingTaskId)}
            confirming={confirmingId === item.id}
            deleting={deletingId === item.id}
            resuming={resumingTaskId === item.workflowTask?.id}
            onOpen={() => void onOpen(item)}
            onResume={(mode) => void resume(item, mode)}
            onAskDelete={() => setConfirmingId((id) => (id === item.id ? null : item.id))}
            onCancelDelete={() => setConfirmingId(null)}
            onConfirmDelete={() => void remove(item)}
          />
        </li>
      ))}
    </ul>
  );
}

function ProductRow({ item, disabled, confirming, deleting, resuming, onOpen, onResume, onAskDelete, onCancelDelete, onConfirmDelete }: {
  item: ProductSummary;
  disabled: boolean;
  confirming: boolean;
  deleting: boolean;
  resuming: boolean;
  onOpen: () => void;
  onResume: (mode: WorkflowTaskRetryMode) => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const meta = productMeta(item);
  const displayState = isProductSupersededByReplacement(item) ? "draft_saved" : item.status;
  const draftSaved = item.status === "draft_saved";
  const progress = draftSaved ? 100 : item.workflowTask?.progress ?? 0;
  const locked = item.status === "automating" || item.workflowTask?.status === "queued" || item.workflowTask?.status === "running";
  const canResume = item.workflowTask?.status === "needs_attention" || item.workflowTask?.status === "failed";

  return (
    <article className={styles.productRow} data-state={displayState}>
      <div
        className={styles.productRowOpen}
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(event) => {
          // 还原 <button> 的键盘语义：Enter / Space 触发进入产品。
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }}
        aria-label={`进入产品详情：${item.name}`}
      >
        <span className={styles.productRowIcon} data-form={meta.form} aria-hidden="true">
          {meta.form === "groupTour" ? <Users size={16} /> : <Briefcase size={16} />}
        </span>
        <span className={styles.productMain}>
          <span className={styles.productTitleLine}>
            <strong className={styles.title}>{item.name}</strong>
            <ProductStatusBadge item={item} />
          </span>
          <span className={styles.productMetaLine}>
            {item.productId ? <CopyableId value={item.productId} label="VBK产品ID" /> : <span className={styles.metaItem}>VBK产品ID：待生成</span>}
            <span className={styles.metaSep} aria-hidden="true">·</span>
            <CopyableId value={item.id} label="列表ID" />
            <span className={styles.metaSep} aria-hidden="true">·</span>
            <span className={styles.metaItem} title={item.vbkAccount ? `创建于 VBK 账号 ${item.vbkAccount}` : "该历史产品尚未记录 VBK 归属账号"}>
              {item.vbkAccount ? `账号 ${item.vbkAccount}` : "未绑定 VBK 账号"}
            </span>
            <span className={styles.metaSep} aria-hidden="true">·</span>
            <span className={`${styles.metaItem} ${styles.metaMuted}`}>更新 {formatUpdatedAt(item.updatedAt)}</span>
            <span className={styles.metaSep} aria-hidden="true">·</span>
            <span className={`${styles.metaItem} ${styles.metaMuted}`}><ProductExecutionTimeLabel time={item.executionTime} /></span>
          </span>
          {item.workflowTask && (
            <span className={styles.productTaskLine} data-status={draftSaved ? "succeeded" : item.workflowTask.status}>
              <span className={styles.productTaskTrack} role="progressbar" aria-label={draftSaved ? "母产品草稿保存进度" : "后台任务进度"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                <span style={{ transform: `scaleX(${progress / 100})` }} />
              </span>
              <span>{draftSaved ? "母产品草稿保存" : productTaskStageLabel(item.workflowTask.stage, item.workflowTask.status)} · {progress}%</span>
              <span className={styles.productTaskMessage}>{item.workflowTask.error || item.workflowTask.message}</span>
            </span>
          )}
        </span>
      </div>

      <div className={styles.productRowActions}>
        {canResume && (
          <div className={styles.productRetryGroup} role="group" aria-label={`重新执行：${item.name}`}>
            <span className={styles.productRetryLabel}>重新执行</span>
            <button
              className={styles.productResumeTrigger}
              type="button"
              onClick={() => onResume("from_error")}
              disabled={disabled}
              aria-label={`从报错处继续执行：${item.name}`}
              title="从报错处继续执行"
            >
              {resuming ? <LoaderCircle size={14} className={styles.spin} /> : <RotateCcw size={14} />}
              <span>从错误处</span>
            </button>
            <button
              className={styles.productRestartTrigger}
              type="button"
              onClick={() => onResume("from_start")}
              disabled={disabled}
              aria-label={`从头开始重新执行：${item.name}`}
          title="从头开始重新执行"
          >
              <RotateCcw size={14} />
              <span>从头开始</span>
            </button>
          </div>
        )}
        <button
          className={styles.productViewTrigger}
          type="button"
          onClick={onOpen}
          disabled={disabled}
          aria-label={`查看产品详情：${item.name}`}
          title="查看产品详情"
        >
          <Eye size={14} />
          <span>查看详情</span>
        </button>
        <button
          className={styles.productDeleteTrigger}
          type="button"
          onClick={onAskDelete}
          disabled={locked || disabled}
          aria-label={`删除产品：${item.name}`}
          title={locked ? "后台任务执行中，暂不能删除" : "删除产品"}
        >
          <Trash2 size={14} />
          <span>删除</span>
        </button>
      </div>

      {confirming && (
        <div className={styles.productDeleteConfirm} role="group" aria-label={`确认删除产品：${item.name}`}>
          <div>
            <strong>删除「{item.name}」？</strong>
            <small>将永久删除本机的产品方案、对话、核查任务和录入记录；不会删除 VBK 平台上的产品。</small>
          </div>
          <div className={styles.productDeleteActions}>
            <button className={`${shared.btn} ${shared.btnSm}`} type="button" onClick={onCancelDelete} disabled={deleting}>取消</button>
            <button className={`${shared.btn} ${shared.btnSm}`} data-variant="danger-solid" type="button" onClick={onConfirmDelete} disabled={deleting}>
              {deleting ? <LoaderCircle size={14} /> : <Trash2 size={14} />}
              确认删除
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

/**
 * 从产品名反解目的地 / 天数 / 产品形态。
 * 输入：「太原3天2晚私家团」「北京2天1晚跟团游」，只解析产品形态图标所需的信息。
 */
function productMeta(item: ProductSummary): { form: ProductForm } {
  const match = item.name.match(/^(.+?)(\d+)天\s*(\d+)晚\s*(.+)$/);
  if (!match) return { form: "privateTour" };
  const kind = match[4];
  const form = (Object.entries(PRODUCT_FORM_LABELS).find(([, label]) => kind.includes(label))?.[0] ?? "privateTour") as ProductForm;
  return { form };
}

// shared button styles imported lazily to avoid a bundling issue with this row's confirm panel
import shared from "../../views/shared.module.less";