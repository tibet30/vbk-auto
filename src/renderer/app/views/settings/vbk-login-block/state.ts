/**
 * useVbkLoginBlockState：把 VbkLoginBlock 组件的全部 hooks + handlers
 * 抽到一个自定义 hook，便于主组件只保留渲染逻辑。
 *
 * 状态：
 *   - accountInfo / loadingAccountInfo / boundOffline
 *   - confirmForgetKey / busyAccount
 *
 * 副作用：
 *   - user.id 变更：刷新账号列表 / 登录状态 / fixedInfoReloadToken；
 *   - currentAccountKey / accounts / token 变化：拉 scoped 账号绑定（offline 探测）；
 *   - login 状态变化：刷新账号列表。
 *
 * 事件：
 *   - handleSwitch / handleForget / handleRefreshStatus。
 */

import { useEffect, useState } from "react";
import type { AccountFixedInfo, SavedLoginAccount } from "../../../../../shared/contracts.js";
import { api } from "../../../helpers";
import type { AppModel } from "../../../app.main.model";
import { hasBindingValues } from "./util.js";

export interface VbkLoginBlockState {
  accountInfo: AccountFixedInfo | null;
  loadingAccountInfo: boolean;
  boundOffline: boolean;
  confirmForgetKey: string | null;
  busyAccount: string | null;
  handleSwitch: (target: SavedLoginAccount) => Promise<void>;
  handleForget: (target: SavedLoginAccount) => Promise<void>;
  handleRefreshStatus: () => Promise<void>;
  setConfirmForgetKey: (value: string | null) => void;
}

export function useVbkLoginBlockState(model: AppModel, userId: string | number, currentAccount: string | null, currentAccountKey: string | null, snapCurrent: SavedLoginAccount | null, snapSaved: SavedLoginAccount[]): VbkLoginBlockState {
  const {
    checkVbkLogin,
    refreshVbkLoginAccounts,
    switchAccount,
    forgetAccount,
    fixedInfoReloadToken,
    setFixedInfoReloadToken,
  } = model;

  const [accountInfo, setAccountInfo] = useState<AccountFixedInfo | null>(null);
  const [loadingAccountInfo, setLoadingAccountInfo] = useState(false);
  const [boundOffline, setBoundOffline] = useState(false);
  const [confirmForgetKey, setConfirmForgetKey] = useState<string | null>(null);
  const [busyAccount, setBusyAccount] = useState<string | null>(null);

  // App 账号切换后 workspace 会按 user.id remount；main 侧 sync 是 fire-and-forget，
  // 这里立刻刷新并延迟再 bump token，让设置页读到新用户的 scoped 绑定。
  useEffect(() => {
    void refreshVbkLoginAccounts();
    void checkVbkLogin(true);
    setFixedInfoReloadToken((value) => value + 1);
    const timer = window.setTimeout(() => {
      setFixedInfoReloadToken((value) => value + 1);
      void refreshVbkLoginAccounts();
    }, 800);
    return () => window.clearTimeout(timer);
    // checkVbkLogin 引用不稳定，刻意只跟 user.id。
  }, [userId]);

  useEffect(() => {
    const client = api();
    if (!client) return;
    let cancelled = false;
    setLoadingAccountInfo(true);

    const finish = (info: AccountFixedInfo | null, offlineBound: boolean) => {
      if (cancelled) return;
      setAccountInfo(info);
      setBoundOffline(offlineBound);
      setLoadingAccountInfo(false);
    };

    void (async () => {
      try {
        if (currentAccount) {
          finish(await client.accounts.getFixedInfo(currentAccountKey ?? currentAccount), false);
          return;
        }
        // 未登录 VBK：用本机已记录账号 key 探测 scoped 绑定（有 400/管家则提示待登录）。
        const keys = [
          snapCurrent?.accountKey,
          snapCurrent?.accountName,
          ...snapSaved.flatMap((entry) => [entry.accountKey, entry.accountName]),
        ]
          .map((key) => (typeof key === "string" ? key.trim() : ""))
          .filter(Boolean);
        for (const key of [...new Set(keys)]) {
          const info = await client.accounts.getFixedInfo(key);
          if (hasBindingValues(info)) {
            finish(info, true);
            return;
          }
        }
        finish(null, false);
      } catch {
        finish(null, false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentAccount, currentAccountKey, snapCurrent?.accountKey, snapCurrent?.accountName, snapSaved, fixedInfoReloadToken]);

  useEffect(() => {
    void refreshVbkLoginAccounts();
  }, [refreshVbkLoginAccounts, model.vbkLogin?.loggedIn]);

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

  return {
    accountInfo,
    loadingAccountInfo,
    boundOffline,
    confirmForgetKey,
    busyAccount,
    handleSwitch,
    handleForget,
    handleRefreshStatus,
    setConfirmForgetKey,
  };
}