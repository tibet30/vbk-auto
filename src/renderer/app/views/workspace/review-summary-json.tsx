import { Braces, ClipboardCheck, ClipboardCopy, FileJson } from "lucide-react";
import shared from "../shared.module.less";
import styles from "./review-summary.module.less";

export interface ReviewSummaryJsonProps {
  /** 序列化好的 JSON 文本，由调用方 useMemo 派生。 */
  jsonText: string;
  /** JSON 字节数，给运营一个体量直觉。 */
  jsonBytes: number;
  /** 顶层键数量，给运营一个结构直觉。 */
  topLevelKeyCount: number;
  copyState: "idle" | "copied";
  onCopy: () => void;
  /** 当 JSON 内容为空时是否禁用复制。 */
  disabled?: boolean;
}

/**
 * 审查结果右侧的 JSON 实时数据视图。
 *
 * - 默认隐藏：进入产品后仍是卡片视图，需要主动切换才出现 JSON；
 * - 全只读：不做语法高亮 / 行号，避免引入额外依赖；运营日常靠「复制全部」把内容带回 AI 对话；
 * - 顶部工具栏保留切换回卡片视图需要的全部信息（标题、字节数、键数量、复制）。
 */
export function AppWorkspaceReviewSummaryJson({
  jsonText,
  jsonBytes,
  topLevelKeyCount,
  copyState,
  onCopy,
  disabled = false,
}: ReviewSummaryJsonProps) {
  const isEmpty = !jsonText || jsonText.trim() === "" || jsonText.trim() === "{}" || topLevelKeyCount === 0;

  return (
    <section className={styles.jsonView} aria-label="产品 JSON 实时数据">
      <header className={styles.jsonToolbar}>
        <span className={styles.jsonToolbarTitle}>
          <Braces size={12} aria-hidden="true" />
          产品 JSON 实时数据
        </span>
        <span className={styles.jsonToolbarMeta}>
          {topLevelKeyCount > 0 ? `${topLevelKeyCount} 个顶层字段` : "等待 AI 写入"}
          <span className={styles.jsonToolbarSep} aria-hidden="true">·</span>
          {formatBytes(jsonBytes)}
        </span>
        <button
          className={`${shared.btn} ${shared.btnSm}`}
          type="button"
          data-variant="secondary"
          onClick={onCopy}
          disabled={disabled || isEmpty}
          aria-label="复制 JSON 数据"
          title={isEmpty ? "尚无 JSON 数据可复制" : "复制全部 JSON 到剪贴板"}
        >
          {copyState === "copied" ? <ClipboardCheck size={13} aria-hidden="true" /> : <ClipboardCopy size={13} aria-hidden="true" />}
          {copyState === "copied" ? "已复制" : "复制全部"}
        </button>
      </header>
      <div className={styles.jsonBody} role="region" aria-label="JSON 数据">
        {isEmpty ? (
          <div className={styles.jsonEmpty}>
            <FileJson size={22} aria-hidden="true" />
            <strong>等待 AI 写入产品 JSON</strong>
            <p>在左侧继续对话，AI 回复会在此实时生成结构化数据。</p>
          </div>
        ) : (
          <pre className={styles.jsonPre}>
            <code>{jsonText}</code>
          </pre>
        )}
      </div>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
