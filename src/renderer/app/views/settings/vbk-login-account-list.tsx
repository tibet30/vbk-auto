import { Trash2, X } from "lucide-react";
import type { SavedLoginAccount } from "../../../../shared/contracts.js";
import shared from "../shared.module.less";
import styles from "./vbk-login-block.module.less";

/** 已记录账号列表：当前账号绿徽章；其余可切换 / 忘记。 */
export interface AccountListProps {
  current: SavedLoginAccount | null;
  saved: SavedLoginAccount[];
  busyAccount: string | null;
  confirmForgetKey: string | null;
  loading: boolean;
  onSwitch: (account: SavedLoginAccount) => void;
  onForget: (account: SavedLoginAccount) => void;
  onCancelForget: () => void;
}

export function AccountList({
  current,
  saved,
  busyAccount,
  confirmForgetKey,
  loading,
  onSwitch,
  onForget,
  onCancelForget,
}: AccountListProps) {
  const all = [...(current ? [current] : []), ...saved];
  if (loading && all.length === 0) {
    return <span className={shared.taskEmpty}>正在读取账号列表…</span>;
  }
  if (all.length === 0) {
    return <span className={shared.taskEmpty}>暂无账号</span>;
  }
  return <div className={styles.accountList}>
    {current && (
      <span className={`${shared.chipMini} ${styles.accountListCurrent}`}>
        <span className={shared.dot} data-state="ok" aria-hidden="true" />
        <span className={styles.accountListName}>{current.accountName}</span>
        <small className={styles.accountListTag}>当前</small>
      </span>
    )}
    {saved.map((entry) => {
      const busy = busyAccount === entry.accountKey;
      const confirming = confirmForgetKey === entry.accountKey;
      return (
        <span
          key={entry.accountKey}
          className={`${shared.chipMini} ${styles.accountListItem} ${busy ? styles.accountListBusy : ""}`}
          data-confirming={confirming || undefined}
        >
          <button
            type="button"
            className={styles.accountListNameBtn}
            onClick={() => onSwitch(entry)}
            disabled={!!busyAccount || busy}
            title={`切换到「${entry.accountName}」`}
          >
            <span className={styles.accountListName}>{entry.accountName}</span>
          </button>
          <button
            type="button"
            className={`${shared.iconBtn} ${styles.accountListForgetBtn}`}
            data-size="sm"
            onClick={() => (confirming ? onCancelForget() : onForget(entry))}
            disabled={!!busyAccount}
            aria-label={confirming ? `取消忘记「${entry.accountName}」` : `忘记「${entry.accountName}」`}
            title={confirming ? "再点一次取消" : "忘记本机的账号快照"}
          >
            {confirming ? <X size={12} aria-hidden="true" /> : <Trash2 size={12} aria-hidden="true" />}
          </button>
        </span>
      );
    })}
  </div>;
}
