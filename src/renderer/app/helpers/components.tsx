import { Briefcase, Check, Copy, Eye, FileText, LoaderCircle, Plus, RotateCcw, Trash2, Users } from "lucide-react";
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { CreateProductInput, ProductSummary, WorkflowTaskRetryMode } from "../../../shared/contracts.js";
import { PRODUCT_FORM_LABELS, type ProductForm } from "../../../shared/product-form.js";
import shared from "../views/shared.module.less";
import { copyText, formatUpdatedAt } from "./constants";
import styles from "./components.module.less";
import { type ProductBriefField, type ProductBriefFieldErrors, validateProductBrief } from "./product-brief-validation";
import { CREATE_PRODUCT_MAX_DAYS, CREATE_PRODUCT_MIN_DAYS, parseProductDaysInput, productDaysInputValue } from "./product-days-input";
import { ProductStatusBadge, productTaskStageLabel } from "./product-task-status";

export function ProductBriefForm({ input, setInput, autoConfirm, setAutoConfirm, submitting, onCancel, onSubmit }: { input: CreateProductInput; setInput: (input: CreateProductInput) => void; autoConfirm: boolean; setAutoConfirm: (value: boolean) => void; submitting: boolean; onCancel: () => void; onSubmit: () => void }) {
  const [fieldErrors, setFieldErrors] = useState<ProductBriefFieldErrors>({});
  const [ideaDraft, setIdeaDraft] = useState(input.userIdea ?? "");
  const ideaRef = useRef<HTMLTextAreaElement>(null);
  const ideaComposingRef = useRef(false);
  const updateInput = (field: ProductBriefField, nextInput: CreateProductInput) => {
    setInput(nextInput);
    if (fieldErrors[field]) setFieldErrors((current) => ({ ...current, [field]: undefined }));
  };
  useEffect(() => {
    if (ideaComposingRef.current) return;
    const nextIdea = input.userIdea ?? "";
    setIdeaDraft((current) => current === nextIdea ? current : nextIdea);
    if (ideaRef.current && ideaRef.current.value !== nextIdea) ideaRef.current.value = nextIdea;
  }, [input.userIdea]);
  const submit = () => {
    const errors = validateProductBrief(input);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    onSubmit();
  };
  return <div className={`${shared.card} ${styles.briefForm}`}>
    <div><h3>新建产品</h3><p className={shared.viewSub}>填写基础信息和你的初步想法，进入产品后 AI 会据此开始规划。</p></div>
    <div className={styles.briefGrid}>
      <label><span className={shared.fieldLabel}>目的地</span><input className={shared.input} autoFocus placeholder="例如：太原" value={input.destination} aria-invalid={Boolean(fieldErrors.destination)} aria-describedby={fieldErrors.destination ? "create-product-destination-error" : undefined} onChange={(event) => updateInput("destination", { ...input, destination: event.target.value })} />{fieldErrors.destination ? <span id="create-product-destination-error" className={styles.fieldError} role="alert">{fieldErrors.destination}</span> : null}</label>
      <label><span className={shared.fieldLabel}>产品形态</span><select className={shared.input} value={input.productForm} onChange={(event) => setInput({ ...input, productForm: event.target.value as CreateProductInput["productForm"] })}>{(Object.entries(PRODUCT_FORM_LABELS) as Array<[ProductForm, string]>).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><span className={shared.fieldLabel}>天数</span><input className={shared.input} type="number" min={CREATE_PRODUCT_MIN_DAYS} max={CREATE_PRODUCT_MAX_DAYS} value={productDaysInputValue(input.days)} aria-invalid={Boolean(fieldErrors.days)} aria-describedby={fieldErrors.days ? "create-product-days-error" : undefined} onChange={(event) => updateInput("days", { ...input, days: parseProductDaysInput(event.target.value) })} />{fieldErrors.days ? <span id="create-product-days-error" className={styles.fieldError} role="alert">{fieldErrors.days}</span> : null}</label>
    </div>
    <label className={styles.ideaField}>
      <span className={shared.fieldLabel}>你的想法 <small>选填</small></span>
      <textarea
        ref={ideaRef}
        className={shared.input}
        rows={5}
        maxLength={1000}
        placeholder="例如：希望节奏慢一点，多安排当地文化体验，适合带孩子出行……"
        defaultValue={input.userIdea ?? ""}
        onCompositionStart={() => { ideaComposingRef.current = true; }}
        onCompositionEnd={(event) => {
          ideaComposingRef.current = false;
          const userIdea = event.currentTarget.value.slice(0, 1000);
          setIdeaDraft(userIdea);
          updateInput("userIdea", { ...input, userIdea });
        }}
        onChange={(event) => {
          const userIdea = event.target.value.slice(0, 1000);
          if (ideaComposingRef.current) return;
          setIdeaDraft(userIdea);
          updateInput("userIdea", { ...input, userIdea });
        }}
        aria-invalid={Boolean(fieldErrors.userIdea)}
        aria-describedby={fieldErrors.userIdea ? "create-product-idea-error" : "product-idea-hint"}
      />
      {fieldErrors.userIdea ? <span id="create-product-idea-error" className={styles.fieldError} role="alert">{fieldErrors.userIdea}</span> : null}
      <span id="product-idea-hint" className={styles.ideaHint}>{ideaDraft.length} / 1000 字，AI 会把它作为需求偏好参考</span>
    </label>
    <label className={styles.autoConfirmOption}>
      <input
        type="checkbox"
        checked={autoConfirm}
        disabled={submitting}
        onChange={(event) => setAutoConfirm(event.target.checked)}
      />
      <span>
        <strong>一键生成并录入携程</strong>
        <small>跳过人工确认；仅在方案通过自动核验后才会写入 VBK。</small>
      </span>
    </label>
    <div className={styles.formActions}>
      <button className={shared.btn} data-variant="ghost" onClick={onCancel}>取消</button>
      <button className={shared.btn} data-variant="primary" disabled={submitting} onClick={submit}>
        {submitting ? (
          <>
            <LoaderCircle size={15} className={styles.spin} />{autoConfirm ? "正在创建后台任务…" : "创建中"}
          </>
        ) : (
          <>
            <Plus size={15} />
            创建
          </>
        )}
      </button>
    </div>
  </div>;
}

export function WorkbenchModule({
  icon,
  title,
  detail,
  state,
  stateLabel,
  hint,
  action,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  state: "ready" | "todo" | "emphasis";
  stateLabel?: string;
  hint?: string;
  action: ReactNode;
}) {
  return <article className={styles.moduleCard} data-state={state}>
    <header className={styles.moduleHead}>
      <span className={styles.moduleIcon} aria-hidden="true">{icon}</span>
      <div className={styles.moduleHeader}>
        <strong className={styles.moduleTitle}>
          {title}
          {stateLabel && <span className={styles.moduleBadge} data-state={state}>{stateLabel}</span>}
        </strong>
      </div>
    </header>
    <p className={styles.moduleBody}>{detail}</p>
    <footer className={styles.moduleFoot}>
      {hint ? <span className={styles.moduleHint}>{hint}</span> : <span />}
      {action}
    </footer>
  </article>;
}

/**
 * 产品列表：每行是一个清晰可扫描的卡片。
 * 标题、状态徽章、产品 ID、账号和更新时间按视觉层级排布，
 * 查看详情 / 删除按钮保持统一的显式操作入口，同时保留点击整行内容进入详情。
 */
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
            item={item}
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
  const locked = item.status === "automating" || item.workflowTask?.status === "queued" || item.workflowTask?.status === "running";
  const canResume = item.workflowTask?.status === "needs_attention" || item.workflowTask?.status === "failed";

  return (
    <article className={styles.productRow} data-state={item.status}>
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
          </span>
          {item.workflowTask && (
            <span className={styles.productTaskLine} data-status={item.workflowTask.status}>
              <span className={styles.productTaskTrack} role="progressbar" aria-label="后台任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.workflowTask.progress}>
                <span style={{ transform: `scaleX(${item.workflowTask.progress / 100})` }} />
              </span>
              <span>{productTaskStageLabel(item.workflowTask.stage, item.workflowTask.status)} · {item.workflowTask.progress}%</span>
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

export function EmptyProductState({
  aiConfigured,
  providerLabel,
}: {
  aiConfigured: boolean;
  providerLabel: string;
}) {
  if (!aiConfigured) {
    return (
      <div className={shared.emptyState}>
        <FileText size={28} />
        <h3>请先配置 AI 模型</h3>
        <p>当前尚未配置 {providerLabel} 的 API Key，无法创建产品。请到「设置」中完成 AI 模型配置后再回来。</p>
      </div>
    );
  }
  return (
    <div className={shared.emptyState}>
      <FileText size={28} />
      <h3>还没有产品</h3>
      <p>从目的地、天数和产品形态开始，几分钟内得到可审查的通用方案。</p>
    </div>
  );
}

export function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.productField}>
      <span className={styles.productFieldLabel}>{label}</span>
      <strong className={styles.productFieldValue} data-state={value === "待生成" ? "empty" : ""}>{value}</strong>
    </div>
  );
}

/**
 * 可复制 ID 徽章：等宽字体显示 ID，点击复制到剪贴板。1.6 秒内显示「已复制」+ 勾选图标，再回到 idle 状态。
 *
 * 使用场景有两种：
 * - 顶栏里作为面包屑 ID chip：父级是 span，不冲突。
 * - 产品列表里嵌在 `productRowOpen` 这个 button 里：产品列表行本身就是「进入产品」按钮，
 *   严格的 HTML 规范不允许在 <button> 里嵌套交互元素；这里采用了实际产品里常见的折中 —
 *   使用 <button> 元素获得原生键盘 / a11y 支持，同时在 click 里默认调用 stopPropagation，
 *   避免被外层识别为「打开产品」。浏览器处理这类嵌套是稳定的。
 */
export function CopyableId({
  value,
  label = "ID",
  className,
  stopClickPropagation = true,
}: {
  value: string;
  label?: string;
  className?: string;
  /** 调用 event.stopPropagation()，避免被父级 button 接收。默认开启。 */
  stopClickPropagation?: boolean;
}) {
  const [state, setState] = useState<"idle" | "copied">("idle");

  const handleCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    if (stopClickPropagation) event.stopPropagation();
    if (state === "copied" || !value) return;
    const ok = await copyText(value);
    if (!ok) return;
    setState("copied");
    window.setTimeout(() => setState("idle"), 1600);
  };

  return (
    <button
      type="button"
      className={`${styles.copyableId} ${className || ""}`}
      data-state={state}
      onClick={handleCopy}
      title={state === "copied" ? `已复制 ${value}` : `点击复制产品 ID：${value}`}
      aria-label={`复制产品 ID ${value}`}
    >
      <span className={styles.copyableIdLabel}>{label}:</span>
      <span className={styles.copyableIdValue}>{state === "copied" ? "已复制" : value}</span>
      <span className={styles.copyableIdIcon} aria-hidden="true">
        {state === "copied" ? <Check size={10} /> : <Copy size={10} />}
      </span>
    </button>
  );
}

// 把后端直发的技术校验文本映射为运营可直接执行的中文提示；保留有意义的
// 非技术描述（如 "建议补充图片"、"需与供应商二次确认"）。输入里出现
// "Invalid input"、"expected ... received"、"undefined"/"null" 等
// Zod/JSON 风格的内部错误信息时一律替换。
export const issueGuidance: Record<string, string> = {
  "basicInfo.supplierProductCode": "请补充供应商产品编码",
  "basicInfo.subtitle": "请填写一句产品副标题",
  "basicInfo.operationNotes": "请补充运营说明",
};
export const technicalDetailPattern = /(invalid input|expected .* received|undefined|null|required|received undefined|received null|invalid_type|invalid_string)/i;
export function formatIssueGuidance(issue: { label: string; detail: string }) {
  const mapped = issueGuidance[issue.label];
  if (mapped) return { guidance: mapped, isTechnical: false };
  const detail = (issue.detail || "").trim();
  if (!detail || technicalDetailPattern.test(detail)) {
    return { guidance: "请在右侧核查后补齐该项内容", isTechnical: true };
  }
  return { guidance: detail, isTechnical: false };
}

export function ShieldCheck(props: { size?: number; className?: string }) {
  const { size = 16, className } = props;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="presentation"
      aria-hidden="true"
    >
      <path d="M12 3l8 3v5c0 4.5-3 8.4-8 9-5-.6-8-4.5-8-9V6l8-3z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
