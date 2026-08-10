/**
 * 「基础信息」模块的共享行 chrome：label + value + actions 三段式网格。
 *
 * 关键约束（与 review-summary-basic-info.module.less 配套）：
 *  - 默认无 max-height / overflow：内容自然高度，行壳跟随扩展；
 *  - 视觉密度收紧：单层 grid，无嵌套大卡；
 *  - 键盘可达：actions 区由调用方传入原生 button；
 *  - 仅展示字段短标签 + 值，不渲染「方案首屏 / 产品页面对接人」类的
 *    逻辑/流程说明文案。
 */
import type { ReactNode } from "react";
import styles from "./review-summary-basic-info.module.less";

export interface BasicInfoRowShellProps {
  /** 字段主标题（如「副标题」「管家联系人」）。 */
  labelTitle: string;
  /** 字段辅助短标签。 */
  labelHint?: string;
  /** 主体内容：展示 div 或编辑控件，由 row 自己决定。 */
  children: ReactNode;
  /** 错误文案（无错误时为 undefined）。 */
  error?: string;
  /** 右侧按钮区：编辑 / 保存 / 取消 / 清除 等按钮。 */
  actions?: ReactNode;
  /** 行 id，方便 ARIA / 自动化测试关联。 */
  rowId?: string;
}

export function BasicInfoRowShell({
  labelTitle,
  labelHint,
  children,
  error,
  actions,
  rowId,
}: BasicInfoRowShellProps) {
  return (
    <div className={styles.row} data-row-id={rowId}>
      <div className={styles.rowLabel}>
        <span className={styles.rowLabelTitle}>{labelTitle}</span>
        {labelHint ? <small className={styles.rowLabelHint}>{labelHint}</small> : null}
      </div>
      <div className={styles.rowValue}>
        {children}
        {error ? <span className={styles.errorLine} role="alert">{error}</span> : null}
      </div>
      {actions ? <div className={styles.rowActions}>{actions}</div> : null}
    </div>
  );
}
