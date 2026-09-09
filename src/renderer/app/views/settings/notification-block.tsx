import { BellRing, ExternalLink, LoaderCircle, Send } from "lucide-react";
import { useState } from "react";
import type { AppModel } from "../../app.main.model";
import { api } from "../../helpers";
import shared from "../shared.module.less";
import styles from "./notification-block.module.less";

type BusyAction = "saving" | "testing" | "opening" | null;

export function NotificationBlock({ model }: { model: AppModel }) {
  const { settings, setSettings, setNotice } = model;
  const [busy, setBusy] = useState<BusyAction>(null);
  const [result, setResult] = useState<string | null>(null);
  const enabled = settings?.systemNotificationsEnabled ?? true;
  const supported = settings?.systemNotificationsSupported ?? true;

  const saveEnabled = async (nextEnabled: boolean) => {
    if (!api() || !settings || busy) return;
    setBusy("saving");
    setResult(null);
    try {
      const next = await api()!.settings.save({ systemNotificationsEnabled: nextEnabled });
      setSettings(next);
      setResult(nextEnabled ? "系统通知已开启。" : "系统通知已关闭。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "保存系统通知设置失败。");
    } finally {
      setBusy(null);
    }
  };

  const testNotification = async () => {
    if (!api() || busy) return;
    setBusy("testing");
    setResult(null);
    try {
      const next = await api()!.settings.testNotification();
      setResult(next.message);
    } catch (error) {
      setResult(error instanceof Error ? error.message : "系统通知发送失败。");
    } finally {
      setBusy(null);
    }
  };

  const openSystemSettings = async () => {
    if (!api() || busy) return;
    setBusy("opening");
    try {
      await api()!.settings.openNotificationSettings();
      setResult("已打开 macOS 通知设置，请确认允许“三人同游”发送通知。");
    } catch (error) {
      setResult(error instanceof Error ? error.message : "无法打开 macOS 通知设置。");
    } finally {
      setBusy(null);
    }
  };

  return <section className={styles.block} aria-labelledby="notification-title">
    <div className={styles.heading}>
      <span className={styles.icon}><BellRing size={18} aria-hidden="true" /></span>
      <div className={styles.headingBody}>
        <h2 id="notification-title">系统通知</h2>
        <p>AI 等待你回复、等待最终确认或执行失败时，通过 macOS 通知提醒你。</p>
      </div>
      <span className={styles.status} data-enabled={enabled && supported}>
        {enabled && supported ? "已开启" : supported ? "已关闭" : "请使用安装版"}
      </span>
    </div>

    <div className={styles.settingRow}>
      <div className={styles.settingCopy}>
        <strong>需要我处理时通知</strong>
        <span>仅在需要人工介入时发送，不提醒普通运行进度。</span>
      </div>
      <button
        type="button"
        className={styles.switch}
        role="switch"
        aria-checked={enabled}
        aria-label="需要我处理时发送系统通知"
        data-checked={enabled}
        disabled={!settings || !supported || busy !== null}
        onClick={() => void saveEnabled(!enabled)}
      >
        <span />
      </button>
    </div>

    <div className={styles.triggerList} aria-label="系统通知触发条件">
      <span>等待补充信息</span>
      <span>等待方案确认</span>
      <span>执行失败</span>
    </div>

    <div className={styles.actions}>
      <p className={styles.hint} role="status" aria-live="polite">
        {result || (!supported
          ? "开发运行方式没有有效应用签名，macOS 不会投递通知；请使用已签名安装包。"
          : "若测试后没有看到通知，请到 macOS 系统设置中允许“三人同游”通知。")}
      </p>
      <div className={shared.btnRow}>
        <button
          type="button"
          className={`${shared.btn} ${shared.btnSm}`}
          onClick={() => void testNotification()}
          disabled={!enabled || !supported || busy !== null}
        >
          {busy === "testing" ? <LoaderCircle size={14} className={styles.spinner} /> : <Send size={14} />}
          {busy === "testing" ? "发送中…" : "发送测试通知"}
        </button>
        <button
          type="button"
          className={`${shared.btn} ${shared.btnSm}`}
          data-variant="secondary"
          onClick={() => void openSystemSettings()}
          disabled={!supported || busy !== null}
        >
          <ExternalLink size={14} />打开系统通知设置
        </button>
      </div>
    </div>
  </section>;
}
