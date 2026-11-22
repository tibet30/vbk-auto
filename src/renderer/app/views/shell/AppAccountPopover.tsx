import { CircleAlert, LogIn, LogOut, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppAuthUser, SavedAppAuthAccount } from "../../../../shared/contracts-auth";
import { appAuthErrorMessage } from "../../auth/app-auth-error";
import { api } from "../../helpers";
import type { AiQuotaSnapshot } from "../../../../shared/contracts-ai-quota";
import shared from "../shared.module.less";
import styles from "./AccountPopover.module.less";
import quotaStyles from "./AccountQuota.module.less";

interface AppAccountPopoverProps {
  user: AppAuthUser;
  savedAccounts: SavedAppAuthAccount[];
  onSwitchAccount: (userId: number) => Promise<void>;
  onStartLogin: () => Promise<void>;
  onLogout: () => Promise<void>;
}

function quotaPercent(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

const QUOTA_APPLY_PRESETS = [50_000_000, 100_000_000];

function formatTokens(value: number): string {
  if (value >= 100_000_000) return `${Math.round(value / 100_000_000)} 亿`;
  if (value >= 10_000) return `${Math.round(value / 10_000)} 万`;
  return String(value);
}

function quotaResumeLabel(endsAt: string | null): string {
  if (!endsAt) return "";
  const end = new Date(endsAt);
  if (Number.isNaN(end.getTime())) return "";
  const clock = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
  const sameDay = end.toDateString() === new Date().toDateString();
  return sameDay ? clock : `${end.getMonth() + 1}/${end.getDate()} ${clock}`;
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
  const [quota, setQuota] = useState<AiQuotaSnapshot | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const [applyTokens, setApplyTokens] = useState(QUOTA_APPLY_PRESETS[0]);
  const [applyReason, setApplyReason] = useState("");
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState("");

  useEffect(() => {
    const bridge = api();
    if (!bridge) return;
    let alive = true;
    void bridge.aiQuota.get()
      .then((snapshot) => { if (alive) setQuota(snapshot); })
      .catch(() => { if (alive) setQuota(null); });
    return () => { alive = false; };
  }, [user.id]);

  const submitApply = async () => {
    const bridge = api();
    if (!bridge) return;
    setApplyBusy(true);
    setApplyError("");
    try {
      await bridge.aiQuota.request({ requestedBillableTokens: applyTokens, reason: applyReason.trim() });
      const snapshot = await bridge.aiQuota.get();
      setQuota(snapshot);
      setApplyOpen(false);
      setApplyReason("");
    } catch (submitError) {
      setApplyError(submitError instanceof Error ? submitError.message : "提交失败");
    } finally {
      setApplyBusy(false);
    }
  };

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

      {quota?.upstream.available && (
        <div className={quotaStyles.quotaBlock} aria-label="AI 额度">
          <div className={quotaStyles.quotaRow}>
            <span className={quotaStyles.quotaLabel}>5 小时</span>
            <span className={quotaStyles.quotaTail}>
              {(quota.upstream.intervalRemainingPercent ?? 100) <= 20 && (
                <span className={quotaStyles.quotaResume}>
                  {quotaResumeLabel(quota.upstream.intervalEndsAt)} 恢复
                </span>
              )}
              <span className={quotaStyles.quotaValue} data-low={(quota.upstream.intervalRemainingPercent ?? 100) <= 20}>
                {quotaPercent(quota.upstream.intervalRemainingPercent)}
              </span>
            </span>
          </div>
          <div className={quotaStyles.quotaRow}>
            <span className={quotaStyles.quotaLabel}>本周</span>
            <span className={quotaStyles.quotaTail}>
              {(quota.upstream.weeklyRemainingPercent ?? 100) <= 20 && (
                <span className={quotaStyles.quotaResume}>
                  {quotaResumeLabel(quota.upstream.weeklyEndsAt)} 恢复
                </span>
              )}
              <span className={quotaStyles.quotaValue} data-low={(quota.upstream.weeklyRemainingPercent ?? 100) <= 20}>
                {quotaPercent(quota.upstream.weeklyRemainingPercent)}
              </span>
            </span>
          </div>
          {quota.memberLimitBillableTokens !== null && (
            <div className={quotaStyles.quotaRow}>
              <span className={quotaStyles.quotaLabel}>本月配额</span>
              <span className={quotaStyles.quotaValue}>{quotaPercent(quota.memberRemainingPercent)}</span>
            </div>
          )}

          {quota.memberLimitBillableTokens !== null && quota.request?.status === "pending" && (
            <div className={quotaStyles.quotaApplyState}>
              待审批 · +{formatTokens(quota.request.requestedBillableTokens)}
            </div>
          )}
          {quota.memberLimitBillableTokens !== null && quota.request?.status === "approved" && (
            <div className={quotaStyles.quotaApplyState} data-state="approved">
              已批准 · +{formatTokens(quota.request.requestedBillableTokens)}
            </div>
          )}
          {quota.memberLimitBillableTokens !== null
            && quota.request?.status === "rejected" && !applyOpen && (
            <div className={quotaStyles.quotaApplyState} data-state="rejected">
              上次申请未通过
            </div>
          )}
          {quota.memberLimitBillableTokens !== null
            && (quota.request === null || quota.request.status === "rejected")
            && !applyOpen && (
            <button
              type="button"
              className={quotaStyles.quotaApplyToggle}
              onClick={() => { setApplyOpen(true); setApplyError(""); }}
            >
              申请追加
            </button>
          )}

          {quota.memberLimitBillableTokens !== null && applyOpen && (
            <div className={quotaStyles.quotaApplyForm}>
              <div className={quotaStyles.quotaApplyPresets} role="group" aria-label="追加额度档位">
                {QUOTA_APPLY_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    aria-pressed={applyTokens === preset}
                    data-selected={applyTokens === preset}
                    className={quotaStyles.quotaApplyPreset}
                    onClick={() => setApplyTokens(preset)}
                    disabled={applyBusy}
                  >
                    +{formatTokens(preset)}
                  </button>
                ))}
              </div>
              <input
                className={quotaStyles.quotaApplyReason}
                value={applyReason}
                onChange={(event) => setApplyReason(event.target.value)}
                placeholder="用途"
                maxLength={200}
                disabled={applyBusy}
              />
              {applyError && <div className={quotaStyles.quotaApplyError}>{applyError}</div>}
              <div className={quotaStyles.quotaApplyActions}>
                <button type="button" className={quotaStyles.quotaApplyCancel}
                  onClick={() => setApplyOpen(false)} disabled={applyBusy}>
                  取消
                </button>
                <button type="button" className={quotaStyles.quotaApplySubmit}
                  onClick={() => void submitApply()}
                  disabled={applyBusy || applyReason.trim().length < 4}>
                  {applyBusy ? "提交中" : "提交申请"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

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
