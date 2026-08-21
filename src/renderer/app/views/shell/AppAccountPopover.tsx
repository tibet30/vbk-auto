import { CircleAlert, LogIn, LogOut, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { AppAuthUser, SavedAppAuthAccount } from "../../../../shared/contracts-auth";
import { appAuthErrorMessage } from "../../auth/app-auth-error";
import shared from "../shared.module.less";
import styles from "./AccountPopover.module.less";

interface AppAccountPopoverProps {
  user: AppAuthUser;
  savedAccounts: SavedAppAuthAccount[];
  onSwitchAccount: (userId: number) => Promise<void>;
  onStartLogin: () => Promise<void>;
  onLogout: () => Promise<void>;
}

function maskPhone(phone: string): string {
  return /^(\d{3})\d+(\d{4})$/.test(phone)
    ? phone.replace(/^(\d{3})\d+(\d{4})$/, "$1****$2")
    : phone;
}

/** 侧栏应用账号菜单：历史会话可直接切换，密码不会保存到本机。 */
export function AppAccountPopover({
  user,
  savedAccounts,
  onSwitchAccount,
  onStartLogin,
  onLogout,
}: AppAccountPopoverProps) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const displayName = user.name.trim() || "未命名用户";
  const accountInitial = displayName.slice(0, 1) || "用";
  const switchableAccounts = savedAccounts.filter((account) => account.user.id !== user.id);

  const runAction = async (
    action: string,
    callback: () => Promise<void>,
  ) => {
    if (busyAction) return;
    setBusyAction(action);
    setError("");
    try {
      await callback();
    } catch (caught) {
      setError(appAuthErrorMessage(caught, "账号操作未完成，请重试。"));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div
      id="app-account-popover"
      className={`${styles.accountPopover} ${styles.appAccountPopover}`}
      data-app-account-menu=""
      aria-label="应用账号切换"
    >
      <div className={styles.popoverHead}>
        <span className={styles.popoverAvatar} aria-hidden="true">
          {accountInitial}
        </span>
        <div className={styles.popoverHeadBody}>
          <span className={styles.popoverKicker}>当前登录用户</span>
          <strong className={styles.popoverIdentityName} title={displayName}>
            {displayName}
          </strong>
          <span className={styles.popoverMeta}>{maskPhone(user.phone)}</span>
        </div>
      </div>

      {switchableAccounts.length > 0 && (
        <div className={styles.popoverSaved} aria-label="以前登录过的账号">
          <div className={styles.popoverSavedHead}>
            <span className={styles.popoverKicker}>以前登录过</span>
            <small className={styles.popoverSavedHint}>免输密码切换</small>
          </div>
          <ul className={styles.popoverSavedList}>
            {switchableAccounts.map((account) => {
              const name = account.user.name.trim() || "未命名用户";
              const busy = busyAction === `switch-${account.user.id}`;
              return (
                <li key={account.user.id} className={styles.popoverSavedItem}>
                  <button
                    type="button"
                    className={`${styles.popoverSavedSwitch} ${styles.appSavedSwitch}`}
                    onClick={() => void runAction(
                      `switch-${account.user.id}`,
                      () => onSwitchAccount(account.user.id),
                    )}
                    disabled={Boolean(busyAction)}
                    aria-label={`切换到 ${name}`}
                  >
                    <span className={styles.appSavedAvatar} aria-hidden="true">{name.slice(0, 1) || "用"}</span>
                    <span className={styles.appSavedBody}>
                      <strong>{name}</strong>
                      <small>{maskPhone(account.user.phone)}</small>
                    </span>
                    <RefreshCw size={12} aria-hidden="true" className={busy ? styles.popoverSpin : undefined} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <button
        type="button"
        className={`${shared.btn} ${shared.btnSm} ${styles.popoverAction}`}
        onClick={() => void runAction("new", onStartLogin)}
        disabled={Boolean(busyAction)}
      >
        <LogIn size={13} aria-hidden="true" />
        {busyAction === "new" ? "正在打开" : "登录其他账号"}
      </button>

      {error && (
        <p className={styles.popoverError} role="alert">
          <CircleAlert size={12} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      <button
        type="button"
        className={styles.popoverLink}
        onClick={() => void runAction("logout", onLogout)}
        disabled={Boolean(busyAction)}
      >
        <LogOut size={12} aria-hidden="true" />
        {busyAction === "logout" ? "正在退出" : "退出当前账号"}
      </button>
    </div>
  );
}
