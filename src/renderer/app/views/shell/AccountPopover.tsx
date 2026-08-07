import { LogIn, LogOut } from "lucide-react";
import shared from "../shared.module.less";
import styles from "./AccountPopover.module.less";

interface AccountPopoverProps {
  currentAccountName: string;
  /** 头像缩写：默认取账号名最后一个数字（vbk_671205 → 5）。 */
  accountInitial: string;
  onSwitchLogin: () => void;
  onLogout: () => void;
  vbkLoggedIn: boolean;
  logoutDisabled: boolean;
}

/**
 * 账号菜单：被侧栏 rail 和顶栏共用。
 * 内容与点击事件由调用方注入，避免在不同位置呈现不同菜单造成不一致。
 */
export function AccountPopover({
  currentAccountName,
  accountInitial,
  onSwitchLogin,
  onLogout,
  vbkLoggedIn,
  logoutDisabled,
}: AccountPopoverProps) {
  return (
    <div className={styles.accountPopover}>
      <div className={styles.popoverHead}>
        <span className={styles.popoverAvatar} aria-hidden="true">
          {accountInitial}
        </span>
        <div className={styles.popoverHeadBody}>
          <span className={styles.popoverKicker}>当前 VBK</span>
          <strong className={styles.popoverName} title={currentAccountName}>
            {currentAccountName}
          </strong>
        </div>
      </div>

      <button className={`${shared.btn} ${shared.btnSm} ${styles.popoverAction}`} onClick={onSwitchLogin}>
        <LogIn size={13} aria-hidden="true" />
        切换登录
      </button>

      {vbkLoggedIn && (
        <button
          type="button"
          className={styles.popoverLink}
          onClick={onLogout}
          disabled={logoutDisabled}
        >
          <LogOut size={12} aria-hidden="true" />
          登出
        </button>
      )}
    </div>
  );
}
