import { CircleAlert, KeyRound, LoaderCircle, Save, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { TibetServiceTokenSnapshot } from "../../../../shared/contracts.js";
import { api } from "../../helpers";
import shared from "../shared.module.less";
import styles from "./tibet-service-block.module.less";

function formatSavedAt(value: string | null): string {
  if (!value) return "—";
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString("zh-CN");
}

function boundLabel(snapshot: TibetServiceTokenSnapshot | null): string {
  const identity = snapshot?.identity ?? null;
  if (!identity) return "未验证";
  if (!identity.boundType) return "未绑定身份（只能读公共接口）";
  const key = identity.boundKey ? `（${identity.boundKey}）` : "";
  return `${identity.boundLabel ?? identity.boundType}${key}${identity.inherited ? " · 继承创建者" : ""}`;
}

/**
 * 设置页的「三人同游服务令牌」卡片。
 *
 * 令牌落本机 0600 文件；这里只能看到前缀掩码，明文永不回传。
 * 保存后立即向服务端自检，把「存了但无效/没权限」当场暴露出来。
 */
export function TibetServiceBlock() {
  const [snapshot, setSnapshot] = useState<TibetServiceTokenSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "verify" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const bridge = api();
    if (!bridge?.settings) { setLoading(false); return; }
    try {
      setSnapshot(await bridge.settings.tibetServiceToken());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取服务令牌状态。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = async (kind: "save" | "verify" | "clear") => {
    const bridge = api();
    if (!bridge?.settings || busy) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === "save") {
        setSnapshot(await bridge.settings.saveTibetServiceToken(draft));
        setDraft("");
      } else if (kind === "verify") {
        setSnapshot(await bridge.settings.verifyTibetServiceToken());
      } else {
        setSnapshot(await bridge.settings.clearTibetServiceToken());
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败，请稍后重试。");
    } finally {
      setBusy(null);
    }
  };

  const configured = snapshot?.configured === true;
  const verified = Boolean(snapshot?.identity);

  return <section className={styles.block} aria-labelledby="tibet-service-title">
    <div className={styles.heading}>
      <div className={styles.icon}><KeyRound size={17} /></div>
      <div>
        <h2 id="tibet-service-title">三人同游服务令牌</h2>
        <p>智能体调用三人同游服务端接口的凭证。保存在本机（仅本人可读），明文不会回传界面。</p>
      </div>
    </div>

    <div className={styles.rows}>
      <div className={styles.row}>
        <span className={styles.rowLabel}>当前状态</span>
        <span className={styles.rowValue} data-tone={configured ? "ok" : "idle"}>
          {loading ? "读取中…" : configured ? `已保存 ${snapshot?.maskedToken ?? ""}` : "未配置"}
        </span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>来源</span>
        <span className={styles.rowValue}>
          {snapshot?.source === "env" ? "环境变量 TIBET_SERVICE_TOKEN（临时覆盖）" : snapshot?.source === "file" ? "本机文件" : "—"}
        </span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>保存时间</span>
        <span className={styles.rowValue}>{formatSavedAt(snapshot?.savedAt ?? null)}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>服务端身份</span>
        <span className={styles.rowValue} data-tone={verified ? "ok" : "idle"}>
          {snapshot?.identity
            ? `${snapshot.identity.name} · ${snapshot.identity.statusLabel}${typeof snapshot.identity.remainingDays === "number" ? ` · 剩余 ${snapshot.identity.remainingDays} 天` : ""} · ${boundLabel(snapshot)}`
            : boundLabel(snapshot)}
        </span>
      </div>
      {snapshot?.identity?.permissions.length
        ? <div className={styles.row}>
          <span className={styles.rowLabel}>权限</span>
          <span className={styles.rowValue}>{snapshot.identity.permissions.join("、")}</span>
        </div>
        : null}
    </div>

    <div className={styles.form}>
      <label className={styles.field}>
        <span className={shared.fieldLabel}>服务令牌</span>
        <input
          className={shared.input}
          type="password"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="stk_…（粘贴后在后台保存一次即可）"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <div className={styles.actions}>
        <button
          className={`${shared.btn} ${shared.btnSm}`}
          data-variant="primary"
          disabled={!draft.trim() || busy !== null}
          onClick={() => void run("save")}
        >
          {busy === "save" ? <LoaderCircle size={14} className={styles.spinner} /> : <Save size={14} />}
          {busy === "save" ? "正在保存并验证" : "保存并验证"}
        </button>
        <button
          className={`${shared.btn} ${shared.btnSm}`}
          data-variant="secondary"
          disabled={!configured || busy !== null}
          onClick={() => void run("verify")}
        >
          {busy === "verify" ? <LoaderCircle size={14} className={styles.spinner} /> : <ShieldCheck size={14} />}
          {busy === "verify" ? "验证中" : "重新验证"}
        </button>
        <button
          className={`${shared.btn} ${shared.btnSm}`}
          data-variant="danger"
          disabled={!configured || busy !== null}
          onClick={() => void run("clear")}
        >
          <Trash2 size={14} />清除本地令牌
        </button>
      </div>
      {error
        ? <p className={styles.status} data-tone="danger" role="alert"><CircleAlert size={13} />{error}</p>
        : null}
      {snapshot?.message
        ? <p className={styles.status} data-tone={verified ? "ok" : "idle"}>{snapshot.message}</p>
        : null}
      <p className={shared.fieldHint}>存储位置：{snapshot?.filePath ?? "读取中…"}</p>
    </div>
  </section>;
}
