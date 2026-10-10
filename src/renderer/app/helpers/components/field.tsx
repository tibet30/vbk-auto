/**
 * Field：单条 label + value 字段；
 *   - value 为 "待生成" 时渲染 data-state="empty" 用于样式提示；
 *   - 在 Workbench / ReviewSummary 等视图广泛复用。
 */

import styles from "../components.module.less";

export function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.productField}>
      <span className={styles.productFieldLabel}>{label}</span>
      <strong className={styles.productFieldValue} data-state={value === "待生成" ? "empty" : ""}>{value}</strong>
    </div>
  );
}