// 最近任务侧栏：任务列表、搜索、置顶/归档/删除，以及默认 20 条、触底加载更多。
import { useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, Pin, Plus, Search, Trash2 } from "lucide-react";
import type { AgentThread, UpdateAgentThreadInput } from "../../../../shared/contracts.js";
import { relativeThreadTime } from "./thread-time";
import styles from "./sidebar.module.less";

interface ThreadSidebarProps {
  threads: AgentThread[];
  selectedId?: string;
  query: string;
  onQueryChange(value: string): void;
  onNew(): void;
  onOpen(id: string): void;
  onUpdate(thread: AgentThread, patch: UpdateAgentThreadInput): void;
  onDelete(thread: AgentThread): void;
}

const PAGE_SIZE = 20;
const CLOCK_TICK_MS = 60_000;
const LOAD_MORE_THRESHOLD_PX = 120;

function hoverStatusLabel(thread: AgentThread): string {
  if (thread.status === "running") return "正在处理";
  if (thread.status === "needs_attention") return "需要处理";
  if (thread.status === "completed") return "已完成";
  if (thread.status === "draft" && thread.messageCount) return `${thread.messageCount} 条记录`;
  return "";
}

export function ThreadSidebar(props: ThreadSidebarProps) {
  const [now, setNow] = useState(() => Date.now());
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setLimit(PAGE_SIZE);
    setConfirmingId(null);
  }, [props.query]);

  const normalized = props.query.trim().toLocaleLowerCase();
  const visible = props.threads.filter((thread) => !normalized || thread.title.toLocaleLowerCase().includes(normalized));
  const active = visible.filter((thread) => thread.status !== "archived");
  const archived = visible.filter((thread) => thread.status === "archived");
  const activeShown = active.slice(0, limit);
  const archivedShown = archived.slice(0, Math.max(0, limit - active.length));
  const hasMore = visible.length > activeShown.length + archivedShown.length;

  const loadMore = () => setLimit((value) => value + PAGE_SIZE);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element || !hasMore) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight > LOAD_MORE_THRESHOLD_PX) return;
    loadMore();
  };

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
      <div className={styles.threadScroll} ref={scrollRef} onScroll={handleScroll}>
        <ThreadGroup label="最近" {...props} now={now} threads={activeShown} confirmingId={confirmingId} onAskRemove={setConfirmingId} />
        {archivedShown.length > 0 && (
          <ThreadGroup label="已归档" {...props} now={now} threads={archivedShown} confirmingId={confirmingId} onAskRemove={setConfirmingId} />
        )}
        {!visible.length && <p className={styles.empty}>没有匹配的任务</p>}
        {hasMore && (
          <button type="button" className={styles.loadMore} onClick={loadMore}>
            加载更多
          </button>
        )}
      </div>
    </aside>
  );
}

function ThreadGroup(props: ThreadSidebarProps & { label: string; threads: AgentThread[]; now: number; confirmingId: string | null; onAskRemove(id: string | null): void }) {
  if (!props.threads.length) return null;
  return (
    <section className={styles.group}>
      <h2>{props.label}</h2>
      {props.threads.map((thread) => {
        const status = hoverStatusLabel(thread);
        const confirming = props.confirmingId === thread.id;
        return (
          <div
            className={styles.threadRow}
            data-active={props.selectedId === thread.id}
            data-confirming={confirming || undefined}
            key={thread.id}
          >
            <button
              type="button"
              className={styles.threadOpen}
              onClick={() => {
                props.onAskRemove(null);
                props.onOpen(thread.id);
              }}
            >
              {thread.pinned && <Pin size={10} className={styles.threadPin} role="img" aria-label="已置顶" />}
              <span className={styles.threadTitle} title={thread.title}>{thread.title}</span>
              <span className={styles.threadMeta}>
                <span className={styles.threadTime}>{relativeThreadTime(thread.updatedAt, props.now)}</span>
                {status && <span className={styles.threadStatus}>{status}</span>}
              </span>
            </button>
            <div className={styles.threadActions}>
              {confirming ? (
                <span
                  className={styles.threadConfirm}
                  role="alertdialog"
                  aria-label={`确认删除任务：${thread.title}`}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") props.onAskRemove(null);
                  }}
                >
                  <button type="button" autoFocus className={styles.confirmCancel} onClick={() => props.onAskRemove(null)}>
                    取消
                  </button>
                  <button
                    type="button"
                    className={styles.confirmRemove}
                    title="任务自带的临时工作区会一并删除；你自己选择的目录不受影响"
                    onClick={() => {
                      props.onAskRemove(null);
                      props.onDelete(thread);
                    }}
                  >
                    确认删除
                  </button>
                </span>
              ) : (
                <>
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
                  <button type="button" aria-label="删除任务" onClick={() => props.onAskRemove(thread.id)}>
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </>
              )}
            </div>
            {thread.unread && <span className={styles.unreadDot} role="img" aria-label="未读" title="未读" />}
          </div>
        );
      })}
    </section>
  );
}
