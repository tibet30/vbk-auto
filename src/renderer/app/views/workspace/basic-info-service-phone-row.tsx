/** 「400 电话」只读行：由账号固定信息维护，基础信息只展示当前账号最新值。 */
import { Phone } from "lucide-react";
import { BasicInfoRowShell } from "./basic-info-row-shell";
import styles from "./review-summary-basic-info.module.less";

export interface BasicInfoServicePhoneRowProps {
  servicePhone: string | null;
}

function normalizePhone(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function BasicInfoServicePhoneRow({ servicePhone }: BasicInfoServicePhoneRowProps) {
  const normalized = normalizePhone(servicePhone);
  return (
    <BasicInfoRowShell rowId="service-phone" className={styles.rowCenter} labelTitle="400 电话">
      {normalized ? (
        <div className={styles.rowDisplay}>
          <Phone size={12} aria-hidden="true" />
          <strong>{normalized}</strong>
          <span className={styles.tag} data-tone="ok">账号已配</span>
        </div>
      ) : (
        <div className={styles.rowDisplay} data-state="empty">
          <Phone size={12} aria-hidden="true" />
          <strong>未设置</strong>
          <span className={styles.tag} data-tone="warn">待补充</span>
        </div>
      )}
    </BasicInfoRowShell>
  );
}
