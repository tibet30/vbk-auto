import { Pencil, Phone, PlugZap, RotateCw, Shield, UserRound, UserSquare2 } from "lucide-react";
import { useAppAuth } from "../../auth/AppAuthContext";
import shared from "../shared.module.less";
import { AccountList } from "./vbk-login-account-list";
import styles from "./vbk-login-block.module.less";
import type { AppModel } from "../../app.main.model";
import { useVbkLoginBlockState } from "./vbk-login-block/state.js";
import { resolveButlerDisplay, resolveFilledCount } from "./vbk-login-block/util.js";

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
  const { user } = useAppAuth();
  const {
    vbkLogin,
    checkingVbkLogin,
    openLogin,
    addNewLogin,
    logoutVbk,
    openAccountEditor,
    vbkLoginAccounts,
    loadingLoginAccounts,
  } = model;

  const loggedIn = !!vbkLogin?.loggedIn;
  const currentAccount = vbkLogin?.accountName ?? null;
  const snapCurrent = vbkLoginAccounts?.current;
  const snapSaved = vbkLoginAccounts?.saved ?? [];
  const currentAccountKey = snapCurrent?.accountKey ?? vbkLogin?.loginAccount ?? currentAccount;
  const currentListAccount = currentAccount
    ? {
        accountKey: snapCurrent?.accountKey ?? vbkLogin?.loginAccount ?? currentAccount,
        accountName: currentAccount,
        lastUsedAt: snapCurrent?.lastUsedAt ?? "",
      }
    : snapCurrent;

  const {
    accountInfo,
    loadingAccountInfo,
    boundOffline,
    confirmForgetKey,
    busyAccount,
    handleSwitch,
    handleForget,
    handleRefreshStatus,
    setConfirmForgetKey,
  } = useVbkLoginBlockState(model, user.id, currentAccount, currentAccountKey ?? null, snapCurrent, snapSaved);

  const phoneValue =
    typeof accountInfo?.values.servicePhone === "string"
      ? accountInfo.values.servicePhone.trim()
      : "";
  const butlerValue = resolveButlerDisplay(accountInfo?.values.butlerName);
  const filledCount = resolveFilledCount(phoneValue, butlerValue);
  const accountInfoState: "confirmed" | "needs" | "blocked" = !loggedIn
    ? "blocked"
    : loadingAccountInfo
      ? "needs"
      : filledCount === 2
        ? "confirmed"
        : filledCount === 1
          ? "needs"
          : "blocked";

  const offlineAccountLabel = !loggedIn && boundOffline
    ? (accountInfo?.accountName || snapCurrent?.accountName || null)
    : null;

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
          ? boundOffline ? "待登录" : "未登录"
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
              ) : offlineAccountLabel ? (
                <>
                  <span>{offlineAccountLabel}</span>
                  <span className={styles.loginAccount}>本机未登录</span>
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
          : boundOffline
            ? "已绑定 VBK，本机尚未登录，请登录后继续"
            : "登录后可在工作台直接读取平台数据。"}
      </div>
      <div className={shared.btnRow}>
        {loggedIn && currentAccount && (
          <button
            className={`${shared.btn} ${shared.btnSm}`}
            onClick={() => void openAccountEditor(currentAccountKey ?? currentAccount)}
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