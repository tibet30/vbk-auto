import { useState } from "react";
import { Archive, ArchiveRestore, Pencil, Pin, Plus, Search } from "lucide-react";
import type { AgentThread, UpdateAgentThreadInput } from "../../../../shared/contracts.js";
import styles from "./sidebar.module.less";

interface ThreadSidebarProps {
  threads: AgentThread[];
  selectedId?: string;
  query: string;
  onQueryChange(value: string): void;
  onNew(): void;
  onOpen(id: string): void;
  onUpdate(thread: AgentThread, patch: UpdateAgentThreadInput): void;
}

function statusLabel(thread: AgentThread): string {
  if (thread.status === "running") return "正在处理";
  if (thread.status === "waiting") return "等待继续";
  if (thread.status === "needs_attention") return "需要处理";
  if (thread.status === "completed") return "已完成";
  if (thread.status === "archived") return "已归档";
  return thread.messageCount ? `${thread.messageCount} 条记录` : "尚未开始";
}

export function ThreadSidebar(props: ThreadSidebarProps) {
  const normalized = props.query.trim().toLocaleLowerCase();
  const visible = props.threads.filter((thread) => !normalized || thread.title.toLocaleLowerCase().includes(normalized));
  const active = visible.filter((thread) => thread.status !== "archived");
  const archived = visible.filter((thread) => thread.status === "archived");

  return (
    <aside className={styles.sidebar} aria-label="最近任务">
      <div className={styles.sidebarHead}>
        <button type="button" className={styles.newTask} onClick={props.onNew}>
          <Plus size={15} aria-hidden="true" />新建任务
        </button>
        <label className={styles.search}>
          <Search size={14} aria-hidden="true" />
          <span className={styles.srOnly}>搜索任务</span>
          <input value={props.query} onChange={(event) => props.onQueryChange(event.target.value)} placeholder="搜索任务" />
        </label>
      </div>
      <div className={styles.threadScroll}>
        {/* threads 必须写在展开运算之后：否则会被 line props 里的全量列表覆盖，
            导致"最近"混入已归档任务、搜索过滤失效。 */}
        <ThreadGroup label="最近" {...props} threads={active} />
        {archived.length > 0 && <ThreadGroup label="已归档" {...props} threads={archived} />}
        {!visible.length && <p className={styles.empty}>没有匹配的任务</p>}
      </div>
    </aside>
  );
}

function ThreadGroup(props: ThreadSidebarProps & { label: string; threads: AgentThread[] }) {
  const [editingId, setEditingId] = useState<string>();
  const [editingTitle, setEditingTitle] = useState("");
  if (!props.threads.length) return null;
  const finishRename = (thread: AgentThread) => {
    const title = editingTitle.trim();
    setEditingId(undefined);
    if (title && title !== thread.title) props.onUpdate(thread, { title });
  };
  return (
    <section className={styles.group}>
      <h2>{props.label}</h2>
      {props.threads.map((thread) => (
        <div className={styles.threadRow} data-active={props.selectedId === thread.id} key={thread.id}>
          {editingId === thread.id ? (
            <div className={styles.threadOpen}>
              <span className={styles.status} data-status={thread.status} />
              <span className={styles.threadCopy}>
                <input
                  className={styles.renameInput}
                  value={editingTitle}
                  autoFocus
                  onChange={(event) => setEditingTitle(event.target.value)}
                  onBlur={() => finishRename(thread)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") finishRename(thread);
                    if (event.key === "Escape") setEditingId(undefined);
                  }}
                />
                <small>{thread.pinned ? "已置顶 · " : ""}{statusLabel(thread)}</small>
              </span>
            </div>
          ) : (
            <button type="button" className={styles.threadOpen} onClick={() => props.onOpen(thread.id)}>
              <span className={styles.status} data-status={thread.status} />
              <span className={styles.threadCopy}>
                <strong>{thread.title}</strong>
                <small>{thread.pinned ? "已置顶 · " : ""}{statusLabel(thread)}</small>
              </span>
            </button>
          )}
          <div className={styles.threadActions}>
            {thread.status !== "archived" && (
              <button type="button" aria-label="重命名任务" onClick={() => {
                setEditingId(thread.id);
                setEditingTitle(thread.title);
              }}>
                <Pencil size={13} aria-hidden="true" />
              </button>
            )}
            {thread.status !== "archived" && (
              <button type="button" aria-label={thread.pinned ? "取消置顶" : "置顶"} onClick={() => props.onUpdate(thread, { pinned: !thread.pinned })}>
                <Pin size={13} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              aria-label={thread.status === "archived" ? "恢复任务" : "归档任务"}
              onClick={() => props.onUpdate(thread, { status: thread.status === "archived" ? "draft" : "archived" })}
            >
              {thread.status === "archived" ? <ArchiveRestore size={13} aria-hidden="true" /> : <Archive size={13} aria-hidden="true" />}
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

