import React from "react";
import { CircleAlert, LoaderCircle, Play, Plus, RefreshCw, Save, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  AgentExternalToolStatus,
  AgentExternalToolsSnapshot,
  AgentMcpServerInput,
} from "../../../../shared/contracts-agent-runtime.js";
import { api } from "../../helpers";
import styles from "./agent-tools-block.module.less";

const EMPTY_ROW: AgentMcpServerInput = { id: "", command: "", args: [] };

type DraftRow = AgentMcpServerInput & { argsText: string; timeoutText: string };

function toDraft(server: AgentMcpServerInput): DraftRow {
  return {
    ...server,
    argsText: (server.args ?? []).join(" "),
    timeoutText: server.timeoutMs ? String(server.timeoutMs) : "",
  };
}

function fromDraft(row: DraftRow): AgentMcpServerInput {
  const timeout = Number(row.timeoutText.trim());
  return {
    id: row.id.trim(),
    command: row.command.trim(),
    args: row.argsText.split(/\s+/u).map((arg) => arg.trim()).filter(Boolean),
    ...(row.label?.trim() ? { label: row.label.trim() } : {}),
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: Math.round(timeout) } : {}),
  };
}

function statusLabel(status: AgentExternalToolStatus): string {
  if (status.state === "ready") return "已连接";
  if (status.state === "connecting") return "连接中";
  if (status.state === "failed") return "不可用";
  if (status.state === "closed") return "已断开";
  return "未连接";
}

/**
 * 设置页的「外部工具（MCP）」卡片。
 *
 * 只做三件事：列出已配置服务与连接状态、编辑配置、重连。
 * 工具是否可写由运行时按 server 的 readOnlyHint 决定，这里不给"放宽权限"的入口。
 */
export function AgentToolsBlock() {
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [snapshot, setSnapshot] = useState<AgentExternalToolsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "refresh" | null>(null);
  const [connectionBusy, setConnectionBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = (next: AgentExternalToolsSnapshot) => {
    setSnapshot(next);
    setRows(next.servers.map(toDraft));
  };

  const load = useCallback(async () => {
    const bridge = api();
    if (!bridge?.agentWorkspace) { setLoading(false); return; }
    try {
      apply(await bridge.agentWorkspace.externalTools());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取外部工具配置。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    const bridge = api();
    if (!bridge?.agentWorkspace || busy) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const next = await bridge.agentWorkspace.saveExternalTools(rows.map(fromDraft));
      apply(next);
      setNotice("配置已保存并重连。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法保存外部工具配置。");
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    const bridge = api();
    if (!bridge?.agentWorkspace || busy) return;
    setBusy("refresh");
    setError(null);
    setNotice(null);
    try {
      apply(await bridge.agentWorkspace.refreshExternalTools());
      setNotice("已重新连接外部服务。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法重新连接外部服务。");
    } finally {
      setBusy(null);
    }
  };

  const setConnection = async (serverId: string, connected: boolean) => {
    const bridge = api();
    if (!bridge?.agentWorkspace || connectionBusy || !serverId) return;
    setConnectionBusy(serverId);
    setError(null);
    setNotice(null);
    try {
      apply(await bridge.agentWorkspace.setExternalToolConnection(serverId, connected));
      setNotice(connected ? `已连接 ${serverId}。` : `已断开 ${serverId}，它的工具暂时不可用。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法切换该服务的连接状态。");
    } finally {
      setConnectionBusy(null);
    }
  };

  const update = (index: number, patch: Partial<DraftRow>) => {
    setRows((current) => current.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  };

  const statusById = new Map((snapshot?.status ?? []).map((entry) => [entry.serverId, entry]));

  return (
    <section className={styles.block} aria-labelledby="agent-tools-title">
      <div className={styles.heading}>
        <span className={styles.icon} aria-hidden="true"><Play size={18} /></span>
        <div className={styles.headingBody}>
          <h2 id="agent-tools-title">外部工具（MCP）</h2>
          <p>接入本机 MCP 服务，让智能体调用外部工具。只读工具直接可用，写入工具仍要逐次授权。</p>
        </div>
        <span className={styles.status} data-tone={readyTone(snapshot)}>
          {readySummary(snapshot)}
        </span>
      </div>

      {loading ? <p className={styles.hint}><LoaderCircle size={13} />正在读取配置…</p> : null}

      {rows.length === 0 && !loading ? (
        <p className={styles.hint}>还没有配置外部服务。添加后可用的工具会出现在智能体的动作列表里。</p>
      ) : null}

      <div className={styles.rows}>
        {rows.map((row, index) => {
          const status = statusById.get(row.id.trim());
          return (
            <div className={styles.row} key={`${row.id}-${index}`}>
              <div className={styles.rowHead}>
                <input className={styles.input} value={row.id} placeholder="id（字母/数字/连字符）"
                  aria-label={`第 ${index + 1} 个服务 id`}
                  onChange={(event) => update(index, { id: event.target.value })} />
                <input className={styles.input} value={row.label ?? ""} placeholder="显示名（可选）"
                  aria-label={`第 ${index + 1} 个服务显示名`}
                  onChange={(event) => update(index, { label: event.target.value })} />
                <button type="button" className={styles.remove} onClick={() => setRows((current) => current.filter((_, position) => position !== index))}
                  aria-label={`移除第 ${index + 1} 个服务`}>
                  <Trash2 size={13} />
                </button>
              </div>
              <div className={styles.rowBody}>
                <input className={styles.input} value={row.command} placeholder="启动命令，例如 /usr/local/bin/npx"
                  aria-label={`第 ${index + 1} 个服务启动命令`}
                  onChange={(event) => update(index, { command: event.target.value })} />
                <input className={styles.input} value={row.argsText} placeholder="参数，空格分隔"
                  aria-label={`第 ${index + 1} 个服务参数`}
                  onChange={(event) => update(index, { argsText: event.target.value })} />
                <input className={styles.input} value={row.timeoutText} placeholder="超时 ms"
                  aria-label={`第 ${index + 1} 个服务超时`}
                  onChange={(event) => update(index, { timeoutText: event.target.value })} />
              </div>
              {status ? (
                <p className={styles.statusLine} data-tone={status.state === "ready" ? "success" : status.state === "closed" ? "muted" : "danger"}>
                  <Square size={10} />{statusLabel(status)}
                  {status.tools.length ? ` · 工具：${status.tools.join("、")}` : ""}
                  {row.id.trim() ? (
                    <button
                      type="button"
                      className={styles.inlineAction}
                      disabled={busy !== null || connectionBusy === row.id.trim()}
                      onClick={() => void setConnection(row.id.trim(), status.state !== "ready")}
                    >
                      {status.state === "ready" ? "断开" : "连接"}
                    </button>
                  ) : null}
                </p>
              ) : null}
              {status?.error ? <p className={styles.error}><CircleAlert size={12} />{status.error}</p> : null}
              {status?.changes.map((change) => (
                <p className={styles.change} key={change}><CircleAlert size={12} />{change}</p>
              ))}
            </div>
          );
        })}
      </div>

      {(snapshot?.skipped ?? []).map((reason) => (
        <p className={styles.change} key={reason}><CircleAlert size={12} />{reason}</p>
      ))}
      {error ? <p className={styles.error} role="alert"><CircleAlert size={12} />{error}</p> : null}
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}

      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={() => setRows((current) => [...current, { ...EMPTY_ROW } as DraftRow])}>
          <Plus size={13} />添加服务
        </button>
        <button type="button" className={styles.secondary} disabled={busy !== null} onClick={() => void refresh()}>
          <RefreshCw size={13} />重新连接
        </button>
        <button type="button" className={styles.primary} disabled={busy !== null} onClick={() => void save()}>
          <Save size={13} />保存并应用
        </button>
      </div>
    </section>
  );
}

function readySummary(snapshot: AgentExternalToolsSnapshot | null): string {
  if (!snapshot) return "读取中";
  if (!snapshot.servers.length) return "未配置";
  const ready = snapshot.status.filter((entry) => entry.state === "ready").length;
  return `${ready}/${snapshot.servers.length} 可用`;
}

function readyTone(snapshot: AgentExternalToolsSnapshot | null): string {
  if (!snapshot || !snapshot.servers.length) return "muted";
  const failed = snapshot.status.some((entry) => entry.state !== "ready");
  return failed ? "danger" : "success";
}
