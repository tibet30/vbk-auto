import { useEffect, useState } from "react";
import { Pencil, Phone, PlugZap, RotateCw, Shield, UserRound, UserSquare2 } from "lucide-react";
import type { AccountFixedInfo, ContactCardSelection } from "../../../../shared/contracts.js";
import { api } from "../../helpers";
import type { AppModel } from "../../app.main.model";
import shared from "../shared.module.less";
import styles from "./vbk-login-block.module.less";

export function VbkLoginBlock({ model }: { model: AppModel }) {
  const {
    loggedAccounts,
    vbkLogin,
    checkingVbkLogin,
    openLogin,
    checkVbkLogin,
    logoutVbk,
    openAccountEditor,
  } = model;

  const loggedIn = !!vbkLogin?.loggedIn;
  const currentAccount = vbkLogin?.accountName ?? null;

  // 当前账号的固定信息（400 电话 + 管家联系人）。
  const [accountInfo, setAccountInfo] = useState<AccountFixedInfo | null>(null);
  const [loadingAccountInfo, setLoadingAccountInfo] = useState(false);

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
  }, [currentAccount]);

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

  return <section className={styles.block}>
    <div className={styles.blockHead}>
      <span className={styles.blockIcon}><UserRound size={18} /></span>
      <div className={styles.blockHeadBody}>
        <strong>VBK 登录</strong>
        <small>登录状态与可用账号</small>
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
              {currentAccount || <span className={shared.taskEmpty}>尚未登录</span>}
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
            <dt className={styles.kvLabel}>已记录账号</dt>
            <dd className={styles.kvValue}>
              {loggedAccounts.length ? (
                <div className={styles.accountChips}>
                  {loggedAccounts.map((account) => (
                    <span
                      key={account}
                      className={`${shared.chipMini} ${account === currentAccount ? styles.accountChipActive : ""}`}
                    >
                      {account}
                      {account === currentAccount && <span className={shared.dot} data-state="ok" />}
                    </span>
                  ))}
                </div>
              ) : (
                <span className={shared.taskEmpty}>暂无账号</span>
              )}
            </dd>
          </div>
          <div className={styles.kvRow}>
            <dt className={styles.kvLabel}>登录入口</dt>
            <dd className={styles.kvValue}>
              <span className={styles.mono}>vbooking.ctrip.com/ivbk</span>
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
        {currentAccount && (
          <button
            className={`${shared.btn} ${shared.btnSm}`}
            onClick={() => void openAccountEditor(currentAccount)}
          >
            <Pencil size={14} /> 编辑账号信息
          </button>
        )}
        <button
          className={`${shared.btn} ${shared.btnSm}`}
          onClick={() => void checkVbkLogin(true)}
          disabled={checkingVbkLogin}
        >
          <RotateCw size={14} /> 刷新状态
        </button>
        <button
          className={`${shared.btn} ${shared.btnSm}`}
          data-variant="primary"
          onClick={() => openLogin()}
          disabled={checkingVbkLogin}
        >
          <PlugZap size={14} /> {loggedIn ? "新增登录" : "登录 VBK"}
        </button>
        {loggedIn && (
          <button
            className={`${shared.btn} ${shared.btnSm}`}
            data-variant="ghost"
            disabled={checkingVbkLogin}
            onClick={() => void logoutVbk()}
          >
            <Shield size={14} /> 退出
          </button>
        )}
      </div>
    </footer>
  </section>;
}