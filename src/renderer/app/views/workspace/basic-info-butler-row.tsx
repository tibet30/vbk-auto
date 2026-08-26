/**
 * 「基础信息 / 管家联系人」只读行。
 * 管家联系人由当前账号固定信息维护；账号设置变更后，父级会自动同步
 * 到产品 JSON，保证自动录入仍能读取完整的 ContactCardSelection。
 */
import { LoaderCircle, UserSquare2 } from "lucide-react";
import type { ContactCardSelection } from "../../../../shared/contracts-types.js";
import { BasicInfoRowShell } from "./basic-info-row-shell";
import styles from "./review-summary-basic-info.module.less";

export interface BasicInfoButlerRowProps {
  snapshotButler: ContactCardSelection | null;
  accountButlerDefault: ContactCardSelection | null;
  saving: boolean;
  error: string | undefined;
}

export function BasicInfoButlerRow({
  snapshotButler,
  accountButlerDefault,
  saving,
  error,
}: BasicInfoButlerRowProps) {
  const displayButler = accountButlerDefault ?? snapshotButler;

  return (
    <BasicInfoRowShell
      rowId="butler"
      className={styles.rowCenter}
      labelTitle="管家联系人"
      error={error}
      actions={saving ? <LoaderCircle size={14} className={styles.spin} aria-label="同步中" /> : undefined}
    >
      {displayButler ? (
        <div className={styles.rowDisplay}>
          <UserSquare2 size={12} aria-hidden="true" />
          <strong>{displayButler.displayName}</strong>
          <span className={styles.tag} data-tone="ok">
            {accountButlerDefault ? "账号默认" : "已绑定"}
          </span>
        </div>
      ) : (
        <div className={styles.rowDisplay} data-state="empty"><span>未设置</span></div>
      )}
    </BasicInfoRowShell>
  );
}
