import { LogIn, LogOut, Plus, RotateCw, Trash2, X } from "lucide-react";
import type { SavedLoginAccount } from "../../../../shared/contracts.js";
import shared from "../shared.module.less";
import styles from "./AccountPopover.module.less";

interface AccountPopoverProps {
  currentAccountName: string;
  /** 头像缩写：默认取账号名最后一个数字（vbk_671205 → 5）。 */
  accountInitial: string;
  onSwitchLogin: () => void;
  onLogout: () => void;
  onAddLogin: () => void;
  onSwitchAccount: (accountKey: string) => void;
  onForgetAccount: (accountKey: string) => void;
  /** 当前 WebView 实际展示的账号 + 本机已记录账号。 */
  savedAccounts: SavedLoginAccount[];
  /** 当前正在操作的账号 key，被占用的 chip 不能再点。 */
  busyAccountKey?: string | null;
  vbkLoggedIn: boolean;
  logoutDisabled: boolean;
}

/**
 * 账号菜单：被侧栏 rail 和顶栏共用。
 * 内容与点击事件由调用方注入，避免在不同位置呈现不同菜单造成不一致。
 *
 * 多账号登录：在头部下方插入"已记录账号"列表，每条带切换 / 忘记按钮。
 * 这是用户在不打开设置页的情况下直接切换账号的入口。
 */
export function AccountPopover({
  currentAccountName,
  accountInitial,
  onSwitchLogin,
  onLogout,
  onAddLogin,
  onSwitchAccount,
  onForgetAccount,
  savedAccounts,
  busyAccountKey,
  vbkLoggedIn,
  logoutDisabled,
}: AccountPopoverProps) {
  // 当前账号与 saved 列表里出现的 key 不应再次出现为可切换项。
  const switchable = savedAccounts.filter((entry) => entry.accountName !== currentAccountName);
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

      {switchable.length > 0 && (
        <div className={styles.popoverSaved} aria-label="已记录账号">
          <div className={styles.popoverSavedHead}>
            <span className={styles.popoverKicker}>已记录账号</span>
            <small className={styles.popoverSavedHint}>点击切换</small>
          </div>
          <ul className={styles.popoverSavedList}>
            {switchable.map((entry) => {
              const busy = entry.accountKey === busyAccountKey;
              return (
                <li key={entry.accountKey} className={styles.popoverSavedItem}>
                  <button
                    type="button"
                    className={styles.popoverSavedSwitch}
                    onClick={() => onSwitchAccount(entry.accountKey)}
                    disabled={Boolean(busyAccountKey)}
                    title={`切换到「${entry.accountName}」`}
                  >
                    <RotateCw size={11} aria-hidden="true" />
                    <span>{entry.accountName}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.popoverSavedForget}
                    onClick={() => onForgetAccount(entry.accountKey)}
                    disabled={Boolean(busyAccountKey) && !busy}
                    aria-label={`忘记「${entry.accountName}」`}
                    title="忘记本机的账号快照"
                  >
                    <Trash2 size={11} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <button className={`${shared.btn} ${shared.btnSm} ${styles.popoverAction}`} onClick={onAddLogin}>
        <Plus size={13} aria-hidden="true" />
        新增登录
      </button>

      <button className={`${shared.btn} ${shared.btnSm} ${styles.popoverAction}`} data-variant="secondary" onClick={onSwitchLogin}>
        <LogIn size={13} aria-hidden="true" />
        {vbkLoggedIn ? "查看登录面板" : "登录 VBK"}
      </button>

      {vbkLoggedIn && (
        <button
          type="button"
          className={styles.popoverLink}
          onClick={onLogout}
          disabled={logoutDisabled}
        >
          <LogOut size={12} aria-hidden="true" />
          退出当前
        </button>
      )}
      {switchable.length === 0 && !vbkLoggedIn && (
        <p className={styles.popoverHint}>
          <X size={11} aria-hidden="true" />
          当前尚未登录 VBK，可点击「登录 VBK」或「新增登录」开始。
        </p>
      )}
    </div>
  );
}
