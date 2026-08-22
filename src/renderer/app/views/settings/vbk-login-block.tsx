import { useEffect, useState } from "react";
import { Pencil, Phone, PlugZap, RotateCw, Shield, Trash2, UserRound, UserSquare2, X } from "lucide-react";
import type { AccountFixedInfo, ContactCardSelection, SavedLoginAccount } from "../../../../shared/contracts.js";
import { api } from "../../helpers";
import type { AppModel } from "../../app.main.model";
import shared from "../shared.module.less";
import styles from "./vbk-login-block.module.less";

/**
 * 多账号登录：把每个 VBK 账号的 cookies 抽出来本机持久化，
 * 让运营在「新增登录 / 切换 / 忘记」之间循环。
 *
 * 字段映射：
 *  - `current`：当前 WebView 实际展示的账号；
 *  - `saved`：本机已记录但未在 WebView 展示的账号；
 *  - 主按钮文案随登录态切换；已登录时调 addNewLogin，未登录时调 openLogin。
 */
export function VbkLoginBlock({ model }: { model: AppModel }) {
  const {
    loggedAccounts,
    vbkLogin,
    checkingVbkLogin,
    openLogin,
    addNewLogin,
    checkVbkLogin,
    logoutVbk,
    openAccountEditor,
    refreshVbkLoginAccounts,
    vbkLoginAccounts,
    switchAccount,
    forgetAccount,
    loadingLoginAccounts,
    fixedInfoReloadToken,
  } = model;

  const loggedIn = !!vbkLogin?.loggedIn;
  const currentAccount = vbkLogin?.accountName ?? null;
  const snapCurrent = vbkLoginAccounts?.current;
  const snapSaved = vbkLoginAccounts?.saved ?? [];
  const currentListAccount = currentAccount
    ? {
        accountKey: snapCurrent?.accountKey ?? vbkLogin?.loginAccount ?? currentAccount,
        accountName: currentAccount,
        lastUsedAt: snapCurrent?.lastUsedAt ?? "",
      }
    : snapCurrent;

  // 当前账号的固定信息（400 电话 + 管家联系人）。
  const [accountInfo, setAccountInfo] = useState<AccountFixedInfo | null>(null);
  const [loadingAccountInfo, setLoadingAccountInfo] = useState(false);
  // 忘记按钮的二次确认态：避免误触把刚加的账号瞬间蒸发。
  const [confirmForgetKey, setConfirmForgetKey] = useState<string | null>(null);
  // 切换 / 忘记 进行中：避免连续点击造成 race condition。
  const [busyAccount, setBusyAccount] = useState<string | null>(null);

  useEffect(() => {
    if (!currentAccount) {
      setAccountInfo(null);
      return;
    }
    const client = api();
    if (!client) return;
    let cancelled = false;
    setLoadingAccountInfo(true);
    client.accounts
      .getFixedInfo(currentAccount)
      .then((info) => {
        if (!cancelled) setAccountInfo(info);
      })
      .catch(() => {
        if (!cancelled) setAccountInfo(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingAccountInfo(false);
      });
    return () => {
      cancelled = true;
    };
    // 保存账号固定信息成功后由全局 reload token 刷新，避免切页后仍显示旧值。
  }, [currentAccount, fixedInfoReloadToken]);

  // 进入页面 / 退出登录 / 新增登录等时机需要让「已记录账号」与 webview 同步；
  // 这里在 vbkLogin.loggedIn 切换 + 初次渲染时拉一次，避免把"刷新账号列表"
  // 跟 checkVbkLogin 绑定导致被网络探测拖慢。
  useEffect(() => {
    void refreshVbkLoginAccounts();
  }, [refreshVbkLoginAccounts, vbkLogin?.loggedIn]);

  const phoneValue =
    typeof accountInfo?.values.servicePhone === "string"
      ? accountInfo.values.servicePhone.trim()
      : "";
  const butlerValue = (() => {
    const raw = accountInfo?.values.butlerName;
    if (raw && typeof raw === "object" && "displayName" in raw) {
      return (raw as ContactCardSelection).displayName;
    }
    return "";
  })();
  const filledCount = (phoneValue ? 1 : 0) + (butlerValue ? 1 : 0);
  const accountInfoState: "confirmed" | "needs" | "blocked" = !loggedIn
    ? "blocked"
    : loadingAccountInfo
      ? "needs"
      : filledCount === 2
        ? "confirmed"
        : filledCount === 1
          ? "needs"
          : "blocked";

  const handleSwitch = async (target: SavedLoginAccount) => {
    if (busyAccount || target.accountKey === snapCurrent?.accountKey) return;
    setBusyAccount(target.accountKey);
    try {
      await switchAccount(target.accountKey);
    } finally {
      setBusyAccount(null);
    }
  };

  const handleForget = async (target: SavedLoginAccount) => {
    if (busyAccount) return;
    if (target.accountKey === snapCurrent?.accountKey) return;
    setBusyAccount(target.accountKey);
    try {
      if (confirmForgetKey === target.accountKey) {
        await forgetAccount(target.accountKey);
        setConfirmForgetKey(null);
      } else {
        setConfirmForgetKey(target.accountKey);
        // 给运营 4 秒考虑时间，逾期自动收回确认态。
        window.setTimeout(() => {
          setConfirmForgetKey((current) => (current === target.accountKey ? null : current));
        }, 4000);
      }
    } finally {
      setBusyAccount(null);
    }
  };

  const handleRefreshStatus = async () => {
    await checkVbkLogin(true);
    await refreshVbkLoginAccounts();
  };

  return <section className={styles.block}>
    <div className={styles.blockHead}>
      <span className={styles.blockIcon}><UserRound size={18} /></span>
      <div className={styles.blockHeadBody}>
        <strong>VBK 登录</strong>
        <small>多账号登录与切换</small>
      </div>
      <span className={`${shared.state} ${styles.headStatus}`} data-state={accountInfoState}>
        <span
          className={shared.dot}
          data-state={accountInfoState === "confirmed" ? "ok" : accountInfoState === "needs" ? "warn" : "block"}
        />
        {!loggedIn
          ? "未登录"
          : loadingAccountInfo
            ? "读取中…"
            : filledCount === 2
              ? "已就绪"
              : filledCount === 1
                ? "待补全"
                : "需配置"}
      </span>
    </div>

    <div className={styles.blockBody}>
      {checkingVbkLogin && !vbkLogin ? (
        <p className={shared.sectionEmpty}>正在检测登录状态…</p>
      ) : (
        <dl className={styles.kv}>
          <div className={styles.kvRow}>
            <dt className={styles.kvLabel}>当前账号</dt>
            <dd className={styles.kvValue}>
              {currentAccount ? (
                <>
                  <span>{currentAccount}</span>
                  {vbkLogin?.loginAccount && vbkLogin.loginAccount !== currentAccount && (
                    <span className={styles.loginAccount} title="VBK 登录账号">
                      {vbkLogin.loginAccount}
                    </span>
                  )}
                </>
              ) : <span className={shared.taskEmpty}>尚未登录</span>}
            </dd>
          </div>
          <div className={styles.kvRow}>
            <dt className={styles.kvLabel}>400 电话</dt>
            <dd className={styles.kvValue}>
              {loadingAccountInfo ? (
                <span className={shared.taskEmpty}>读取中…</span>
              ) : phoneValue ? (
                <>
                  <Phone size={12} aria-hidden="true" />
                  <span className={styles.mono}>{phoneValue}</span>
                </>
              ) : (
                <span className={shared.taskEmpty}>尚未设置</span>
              )}
            </dd>
          </div>
          <div className={styles.kvRow}>
            <dt className={styles.kvLabel}>管家联系人</dt>
            <dd className={styles.kvValue}>
              {loadingAccountInfo ? (
                <span className={shared.taskEmpty}>读取中…</span>
              ) : butlerValue ? (
                <>
                  <UserSquare2 size={12} aria-hidden="true" />
                  <span>{butlerValue}</span>
                  <small className={styles.kvHintInline}>产品页面对接人</small>
                </>
              ) : (
                <span className={shared.taskEmpty}>尚未选择</span>
              )}
            </dd>
          </div>
          <div className={styles.kvRow}>
            <dt className={styles.kvLabel}>登录入口</dt>
            <dd className={styles.kvValue}>
              <span className={styles.mono}>vbooking.ctrip.com/ivbk</span>
            </dd>
          </div>
          <div className={styles.kvRow}>
            <dt className={styles.kvLabel}>已记录账号</dt>
            <dd className={styles.kvValue}>
              <AccountList
                current={currentListAccount}
                saved={snapSaved}
                busyAccount={busyAccount}
                confirmForgetKey={confirmForgetKey}
                loading={loadingLoginAccounts}
                onSwitch={(target) => void handleSwitch(target)}
                onForget={(target) => void handleForget(target)}
                onCancelForget={() => setConfirmForgetKey(null)}
              />
            </dd>
          </div>
        </dl>
      )}
    </div>

    <footer className={styles.blockFoot}>
      <div className={styles.footHint}>
        {loggedIn
          ? filledCount === 2
            ? "账号信息已就绪，可执行 VBK 录入。"
            : "补全 400 电话与管家联系人后，录入可自动填表。"
          : "登录后可在工作台直接读取平台数据。"}
      </div>
      <div className={shared.btnRow}>
        {loggedIn && currentAccount && (
          <button
            className={`${shared.btn} ${shared.btnSm}`}
            onClick={() => void openAccountEditor(currentAccount)}
          >
            <Pencil size={14} /> 编辑账号信息
          </button>
        )}
        <button
          className={`${shared.btn} ${shared.btnSm}`}
          onClick={() => void handleRefreshStatus()}
          disabled={checkingVbkLogin}
        >
          <RotateCw size={14} /> 刷新状态
        </button>
        {loggedIn ? (
          <button
            className={`${shared.btn} ${shared.btnSm}`}
            data-variant="primary"
            onClick={() => void addNewLogin()}
            disabled={checkingVbkLogin || loadingLoginAccounts}
            title="把当前账号的登录态保存到本机，再清空浏览器让你登录下一个账号"
          >
            <PlugZap size={14} /> 新增登录
          </button>
        ) : (
          <button
            className={`${shared.btn} ${shared.btnSm}`}
            data-variant="primary"
            onClick={() => openLogin()}
            disabled={checkingVbkLogin}
          >
            <PlugZap size={14} /> 登录 VBK
          </button>
        )}
        {loggedIn && (
          <button
            className={`${shared.btn} ${shared.btnSm}`}
            data-variant="ghost"
            disabled={checkingVbkLogin}
            onClick={() => void logoutVbk()}
            title="清空当前 VBK 浏览器中的登录态；其他已记录账号仍保留"
          >
            <Shield size={14} /> 退出当前
          </button>
        )}
      </div>
    </footer>
  </section>;
}

/**
 * 已记录账号列表：当前账号用绿色徽章标记，其余每个都是可点击切换 / 忘记的 chip。
 * 与 vbk-login-block.module.less 中的 .accountList* 系列配套。
 */
interface AccountListProps {
  current: SavedLoginAccount | null;
  saved: SavedLoginAccount[];
  busyAccount: string | null;
  confirmForgetKey: string | null;
  loading: boolean;
  onSwitch: (account: SavedLoginAccount) => void;
  onForget: (account: SavedLoginAccount) => void;
  onCancelForget: () => void;
}

function AccountList({ current, saved, busyAccount, confirmForgetKey, loading, onSwitch, onForget, onCancelForget }: AccountListProps) {
  const all = [
    ...(current ? [current] : []),
    ...saved,
  ];
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
