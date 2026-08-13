import { AlertTriangle, Briefcase, Check, ChevronRight, Copy, FileText, LoaderCircle, MapPin, PackageOpen, Plus, Sparkles, Trash2, Users } from "lucide-react";
import { type MouseEvent, type ReactNode, useState } from "react";
import type { CreateProductInput, ProductSummary } from "../../../shared/contracts.js";
import shared from "../views/shared.module.less";
import { copyText, formatUpdatedAt } from "./constants";
import styles from "./components.module.less";

export function ProductBriefForm({ input, setInput, submitting, onCancel, onSubmit }: { input: CreateProductInput; setInput: (input: CreateProductInput) => void; submitting: boolean; onCancel: () => void; onSubmit: () => void }) {
  return <div className={`${shared.card} ${styles.briefForm}`}>
    <div><h3>新建产品</h3><p className={shared.viewSub}>只需填写产品的三个基础信息；进入详情后再开始和 AI 沟通。</p></div>
    <div className={styles.briefGrid}>
      <label><span className={shared.fieldLabel}>目的地</span><input className={shared.input} autoFocus placeholder="例如：太原" value={input.destination} onChange={(event) => setInput({ ...input, destination: event.target.value })} /></label>
      <label><span className={shared.fieldLabel}>产品形态</span><select className={shared.input} value={input.productForm} onChange={(event) => setInput({ ...input, productForm: event.target.value as CreateProductInput["productForm"] })}><option value="privateTour">私家团</option><option value="groupTour">跟团游</option></select></label>
      <label><span className={shared.fieldLabel}>天数</span><input className={shared.input} type="number" min="2" max="60" value={input.days} onChange={(event) => setInput({ ...input, days: Math.max(2, Number(event.target.value) || 2) })} /></label>
    </div>
    <div className={styles.formActions}><button className={shared.btn} data-variant="ghost" onClick={onCancel}>取消</button><button className={shared.btn} data-variant="primary" disabled={submitting} onClick={onSubmit}>{submitting ? <LoaderCircle size={15} /> : <Plus size={15} />}创建并进入产品</button></div>
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
 * 标题、状态徽章、产品形态、VBK ID / 本地草稿、更新时间按视觉层级排布，
 * 删除按钮在 hover 时浮现，避免误触又不至于太隐蔽。
 */
export function ProductList({ products, onOpen, onDelete }: { products: ProductSummary[]; onOpen: (item: ProductSummary) => Promise<void>; onDelete: (item: ProductSummary) => Promise<boolean> }) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const remove = async (item: ProductSummary) => {
    if (deletingId) return;
    setDeletingId(item.id);
    const removed = await onDelete(item);
    setDeletingId(null);
    if (removed) setConfirmingId(null);
  };

  return (
    <ul className={styles.productList} aria-label="产品列表">
      {products.map((item) => (
        <li className={styles.productListItem} key={item.id}>
          <ProductRow
            item={item}
            disabled={Boolean(deletingId)}
            confirming={confirmingId === item.id}
            deleting={deletingId === item.id}
            onOpen={() => void onOpen(item)}
            onAskDelete={() => setConfirmingId((id) => (id === item.id ? null : item.id))}
            onCancelDelete={() => setConfirmingId(null)}
            onConfirmDelete={() => void remove(item)}
          />
        </li>
      ))}
    </ul>
  );
}

function ProductRow({ item, disabled, confirming, deleting, onOpen, onAskDelete, onCancelDelete, onConfirmDelete }: {
  item: ProductSummary;
  disabled: boolean;
  confirming: boolean;
  deleting: boolean;
  onOpen: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const meta = productMeta(item);
  const linked = Boolean(item.productId);
  const locked = item.status === "automating";

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
            <ProductStatusBadge status={item.status} />
          </span>
          <span className={styles.productMetaLine}>
            <span className={styles.metaItem}>
              <MapPin size={11} aria-hidden="true" />
              {meta.destination}
            </span>
            <span className={styles.metaSep} aria-hidden="true">·</span>
            <span className={styles.metaItem}>{meta.spec}</span>
            <span className={styles.metaSep} aria-hidden="true">·</span>
            <span className={`${styles.metaItem} ${linked ? styles.metaLink : ""}`}>
              {linked ? `VBK ${item.productId}` : "本地产品草稿"}
            </span>
            <span className={styles.metaSep} aria-hidden="true">·</span>
            <CopyableId value={item.id} />
            <span className={styles.metaSep} aria-hidden="true">·</span>
            <span className={`${styles.metaItem} ${styles.metaMuted}`}>更新 {formatUpdatedAt(item.updatedAt)}</span>
          </span>
        </span>
        <span className={styles.productEnter} aria-hidden="true">
          <ChevronRight size={16} />
        </span>
      </div>

      <button
        className={styles.productDeleteTrigger}
        type="button"
        onClick={onAskDelete}
        disabled={locked || disabled}
        aria-label={`删除产品：${item.name}`}
        title={locked ? "自动录入中，暂不能删除" : "删除产品"}
      >
        <Trash2 size={15} />
      </button>

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
 * 输入：「太原3天2晚私家团」「北京2天1晚跟团游」
 * 解析失败时返回「-」占位，避免 UI 抖动。
 */
function productMeta(item: ProductSummary): { destination: string; spec: string; form: "privateTour" | "groupTour" } {
  const match = item.name.match(/^(.+?)(\d+)天\s*(\d+)晚\s*(.+)$/);
  if (!match) return { destination: item.name, spec: "本地草稿", form: "privateTour" };
  const destination = match[1];
  const days = match[2];
  const nights = match[3];
  const kind = match[4];
  const form: "privateTour" | "groupTour" = kind.includes("跟团") ? "groupTour" : "privateTour";
  return { destination, spec: `${days} ${nights}`, form };
}

/**
 * 产品状态徽章：颜色 + 图标 + 文本三要素并存，让运营一眼读出产品所处阶段。
 * planning 与 automating 都用 AI 色，但 automating 加 spinner 让"正在动"显式可感。
 */
function ProductStatusBadge({ status }: { status: ProductSummary["status"] }) {
  switch (status) {
    case "planning":
      return <span className={styles.productBadge} data-state="planning"><Sparkles size={11} aria-hidden="true" />方案规划中</span>;
    case "review":
      return <span className={styles.productBadge} data-state="review"><CircleHelpSmall />等待确认</span>;
    case "automating":
      return <span className={styles.productBadge} data-state="automating"><LoaderCircle size={11} aria-hidden="true" />正在录入</span>;
    case "draft_saved":
      return <span className={styles.productBadge} data-state="draft_saved"><Check size={11} aria-hidden="true" />草稿已保存</span>;
    case "blocked":
      return <span className={styles.productBadge} data-state="blocked"><AlertTriangle size={11} aria-hidden="true" />需要处理</span>;
    default:
      return <span className={styles.productBadge}>未开始</span>;
  }
}

function CircleHelpSmall() {
  // Lightweight inline question mark to avoid pulling another icon
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 0 1 4.9.6c0 1.7-2.4 2-2.4 3.4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

export function EmptyProductState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className={shared.emptyState}>
      <FileText size={28} />
      <h3>还没有产品</h3>
      <p>从目的地、天数和产品形态开始，几分钟内得到可审查的通用方案。</p>
      <button className={shared.btn} data-variant="primary" onClick={onCreate}><Plus size={15} />创建第一个产品</button>
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
      <span className={styles.copyableIdLabel}>{label}</span>
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
