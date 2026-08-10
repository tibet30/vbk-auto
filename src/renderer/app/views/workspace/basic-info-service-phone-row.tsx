/**
 * 「400 电话」行：账号 AccountFixedInfo.servicePhone。
 *
 * 行为契约（与用户验收门对齐）：
 *  - 仅在 servicePhone 非空时本行才被父组件挂载（避免「空值默认隐藏」违反）；
 *  - 默认紧凑展示电话本身 + 「账号已配」chip；
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
  servicePhone: string;
  /** 当前账号名（用于判断是否能引导到账号设置）。 */
  currentAccountName: string | null;
  onOpenAccountEditor: () => void;
}

export function BasicInfoServicePhoneRow({
  servicePhone,
  currentAccountName,
  onOpenAccountEditor,
}: BasicInfoServicePhoneRowProps) {
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
          aria-label="去账号设置编辑 400 电话"
          title={currentAccountName ? "去账号设置编辑 400 电话" : "请先登录 VBK"}
        >
          <Settings size={12} aria-hidden="true" />账号设置
        </button>
      }
    >
      <div className={styles.rowDisplay}>
        <Phone size={12} aria-hidden="true" />
        <strong>{servicePhone}</strong>
        <span className={styles.tag} data-tone="ok">账号已配</span>
      </div>
    </BasicInfoRowShell>
  );
}