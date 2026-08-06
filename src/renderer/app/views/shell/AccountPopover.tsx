import { UserRound } from "lucide-react";
import shared from "../shared.module.less";
import styles from "./AccountPopover.module.less";

interface AccountPopoverProps {
  currentAccountName: string;
  onSwitchLogin: () => void;
  onLogout: () => void;
  vbkLoggedIn: boolean;
  logoutDisabled: boolean;
}

/**
 * 账号菜单：被侧栏 rail 和顶栏共用。
 * 内容与点击事件由调用方注入，避免在不同位置呈现不同菜单造成不一致。
 */
export function AccountPopover({ currentAccountName, onSwitchLogin, onLogout, vbkLoggedIn, logoutDisabled }: AccountPopoverProps) {
  return (
    <div className={styles.accountPopover}>
      <span className={styles.popoverKicker}>当前 VBK</span>
      <strong>{currentAccountName}</strong>
      <button className={`${shared.btn} ${shared.btnSm}`} onClick={onSwitchLogin}>
        <UserRound size={14} />
        切换登录
      </button>
      {vbkLoggedIn && (
        <button
          className={`${shared.btn} ${shared.btnSm}`}
          data-variant="ghost"
          onClick={onLogout}
          disabled={logoutDisabled}
        >
          登出
        </button>
      )}
    </div>
  );
}
