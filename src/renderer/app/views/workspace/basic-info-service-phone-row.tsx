/**
 * 「400 电话」行：账号 AccountFixedInfo.servicePhone。
 *
 * 行为契约（与用户验收门对齐）：
 *  - 父组件不再按 servicePhone 非空来决定是否挂载 —— 只要进入基础信息模块，
 *    本行就始终可见；servicePhone 缺失时显示「未设置」紧凑空状态 + 「去账号设置」
 *    入口，避免用户找不到修改途径；
 *  - 默认紧凑展示电话本身 + 「账号已配」chip（已设置）；未设置时展示「未设置」
 *    chip + 「去账号设置」按钮，引导到账号页签；
 *  - 行壳上没有「编辑」按钮：400 电话属于账号设置范畴，UI 这里只放
 *    「去账号设置」快捷按钮，避免在基础信息模块里增加一个文本输入；
 *  - 该字段不写入 product（precondition-only），但创建项目时由
 *    assertCreatePreconditions 强校验，必须保持可读。
 */
import { Phone, Settings } from "lucide-react";
import shared from "../shared.module.less";
import { BasicInfoRowShell } from "./basic-info-row-shell";
import styles from "./review-summary-basic-info.module.less";

export interface BasicInfoServicePhoneRowProps {
  /** 当前账号 AccountFixedInfo.servicePhone；null / 空串视为未设置。 */
  servicePhone: string | null;
  /** 当前账号名（用于判断是否能引导到账号设置）。 */
  currentAccountName: string | null;
  onOpenAccountEditor: () => void;
}

function normalizePhone(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function BasicInfoServicePhoneRow({
  servicePhone,
  currentAccountName,
  onOpenAccountEditor,
}: BasicInfoServicePhoneRowProps) {
  const normalized = normalizePhone(servicePhone);
  const hasValue = normalized !== null;
  return (
    <BasicInfoRowShell
      rowId="service-phone"
      labelTitle="400 电话"
      actions={
        <button
          type="button"
          className={`${shared.btn} ${shared.btnSm}`}
          onClick={onOpenAccountEditor}
          disabled={!currentAccountName}
          aria-label={hasValue ? "去账号设置编辑 400 电话" : "去账号设置 400 电话"}
          title={currentAccountName
            ? (hasValue ? "去账号设置编辑 400 电话" : "去账号设置 400 电话")
            : "请先登录 VBK"}
        >
          <Settings size={12} aria-hidden="true" />{hasValue ? "账号设置" : "去账号设置"}
        </button>
      }
    >
      {hasValue && normalized ? (
        <div className={styles.rowDisplay}>
          <Phone size={12} aria-hidden="true" />
          <strong>{normalized}</strong>
          <span className={styles.tag} data-tone="ok">账号已配</span>
        </div>
      ) : (
        <>
          <div className={styles.rowDisplay} data-state="empty">
            <Phone size={12} aria-hidden="true" />
            <strong>未设置</strong>
            <span className={styles.tag} data-tone="warn">待补充</span>
          </div>
          <span className={styles.hint}>
            {currentAccountName
              ? <>当前账号 <strong>{currentAccountName}</strong> 尚未配置 400 电话，点击「去账号设置」补全。</>
              : "先登录 VBK 后再到账号设置里配置 400 电话。"}
          </span>
        </>
      )}
    </BasicInfoRowShell>
  );
}
