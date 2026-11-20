import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, X } from "lucide-react";
import type {
  AgentApprovalScope,
  AgentCapabilities,
  AgentThreadWorkspace,
} from "../../../../shared/contracts-agent-runtime.js";
import type { AgentThread, UpdateAgentThreadInput } from "../../../../shared/contracts.js";
import type { AppModel } from "../../app.main.model";
import { api } from "../../helpers";
import { AgentHome } from "./AgentHome";
import { AgentThreadView } from "./AgentThreadView";
import { ThreadSidebar } from "./ThreadSidebar";
import { nextEnabledSkills } from "./skill-scope";
import { agentWorkspaceError, type AgentWorkspaceError } from "./workspace-error";
import styles from "./workspace.module.less";

type Bridge = NonNullable<ReturnType<typeof api>>;

export function AgentWorkspacePage({ model }: { model: AppModel }) {
  const [threads, setThreads] = useState<AgentThread[]>([]);
  const [detail, setDetail] = useState<AgentThreadWorkspace | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AgentWorkspaceError | null>(null);
  const [capabilities, setCapabilities] = useState<AgentCapabilities>();
  const [homeKey, setHomeKey] = useState(0);
  const mounted = useRef(false);
  // 视图代次：新建任务 / 切换任务都会推进它，在途请求回来时据此丢弃过期结果，
  // 否则一个跑得慢的运行会把用户刚打开的首页或别的任务重新顶掉。
  const viewEpoch = useRef(0);

  const refresh = useCallback(async (preferredId?: string, expectedEpoch?: number) => {
    const bridge = api();
    if (!bridge?.agentWorkspace) { setLoading(false); return; }
    if (!mounted.current) return;
    const epoch = expectedEpoch ?? viewEpoch.current;
    try {
      const next = await bridge.agentWorkspace.list();
      if (epoch !== viewEpoch.current) { setThreads(next); return; }
      const id = preferredId ?? detail?.thread.id;
      const opened = id && next.some((thread) => thread.id === id) ? await bridge.agentWorkspace.get(id) : null;
      if (epoch !== viewEpoch.current) { setThreads(next); return; }
      setThreads(opened ? next.map((thread) => thread.id === opened.thread.id ? { ...thread, unread: opened.thread.unread } : thread) : next);
      if (opened) setDetail(opened);
      else if (detail && !next.some((thread) => thread.id === detail.thread.id)) setDetail(null);
    } catch (reason) {
      setError(agentWorkspaceError(reason, "无法加载智能体任务。"));
    } finally { setLoading(false); }
  }, [detail?.thread.id]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    const bridge = api();
    if (!bridge?.agentWorkspace) return;
    void bridge.agentWorkspace.capabilities().then(setCapabilities).catch(() => setCapabilities(undefined));
  }, []);

  const open = async (id: string) => {
    const bridge = api();
    if (!bridge?.agentWorkspace) return;
    viewEpoch.current += 1;
    const epoch = viewEpoch.current;
    setError(null);
    try {
      const workspace = await bridge.agentWorkspace.get(id);
      if (epoch !== viewEpoch.current) return;
      setDetail(workspace);
      setThreads((current) => current.map((thread) => thread.id === id
        ? { ...thread, unread: workspace.thread.unread }
        : thread));
    } catch (reason) {
      if (epoch !== viewEpoch.current) return;
      setError(agentWorkspaceError(reason, "无法打开任务。"));
    }
  };

  // 新建任务的语义是「回到首页输入框」，不落库空白任务：任务在第一条消息发出时才创建。
  // 每次点击都要拿到一个干净的输入框，所以用 key 重挂首页，顺手清掉上一次没发出去的草稿。
  const startNew = () => {
    viewEpoch.current += 1;
    setDetail(null);
    setSending(false);
    setPending(false);
    setError(null);
    setHomeKey((value) => value + 1);
  };

  const start = async (prompt: string) => {
    const bridge = api();
    if (!bridge?.agentWorkspace || sending) return;
    const epoch = viewEpoch.current;
    let threadId: string | undefined;
    setSending(true);
    setError(null);
    try {
      const thread = await bridge.agentWorkspace.create();
      threadId = thread.id;
      const created = await bridge.agentWorkspace.get(thread.id);
      if (epoch === viewEpoch.current) setDetail(created);
      const next = await bridge.agentWorkspace.send(thread.id, prompt);
      if (epoch === viewEpoch.current) setDetail(next);
      await refresh(thread.id, epoch);
    } catch (reason) {
      setError(agentWorkspaceError(reason, "任务执行失败。"));
      if (threadId) await refresh(threadId, epoch);
    } finally {
      if (epoch === viewEpoch.current) setSending(false);
    }
  };

  const send = async (content: string) => {
    const bridge = api();
    if (!bridge?.agentWorkspace || !detail || sending) return;
    const threadId = detail.thread.id;
    const epoch = viewEpoch.current;
    setSending(true);
    setError(null);
    try {
      const next = await bridge.agentWorkspace.send(threadId, content);
      if (epoch === viewEpoch.current) setDetail(next);
      await refresh(threadId, epoch);
    } catch (reason) {
      setError(agentWorkspaceError(reason, "任务执行失败。"));
      await refresh(threadId, epoch);
    } finally {
      if (epoch === viewEpoch.current) setSending(false);
    }
  };

  // 审批 / 拒绝 / 取消：都是同一个 main 进程往返，成功后用返回的工作区事实覆盖本地状态。
  const act = async (
    call: (bridge: Bridge, threadId: string) => Promise<AgentThreadWorkspace>,
    fallback: string,
  ) => {
    const bridge = api();
    if (!bridge?.agentWorkspace || !detail || pending) return;
    const threadId = detail.thread.id;
    const epoch = viewEpoch.current;
    setPending(true);
    setError(null);
    try {
      const next = await call(bridge, threadId);
      if (epoch === viewEpoch.current) setDetail(next);
      await refresh(threadId, epoch);
    } catch (reason) {
      setError(agentWorkspaceError(reason, fallback));
      await refresh(threadId, epoch);
    } finally { setPending(false); }
  };

  const approve = (toolCallId: string, scope: AgentApprovalScope) =>
    void act((bridge, threadId) => bridge.agentWorkspace.approve(threadId, toolCallId, scope), "无法完成授权。");

  const reject = (toolCallId: string) =>
    void act((bridge, threadId) => bridge.agentWorkspace.reject(threadId, toolCallId), "无法拒绝该动作。");

  const reconcile = (toolCallId: string) =>
    void act((bridge, threadId) => bridge.agentWorkspace.reconcile(threadId, toolCallId), "无法核查该动作的结果。");

  const openArtifact = async (receiptId: string, mode: "open" | "reveal") => {
    const bridge = api();
    if (!bridge?.agentWorkspace || !detail) return;
    try {
      await bridge.agentWorkspace.openArtifact(detail.thread.id, receiptId, mode);
    } catch (reason) {
      setError(agentWorkspaceError(reason, "无法打开产物。"));
    }
  };

  const toggleSkill = async (skillId: string) => {
    const bridge = api();
    if (!bridge?.agentWorkspace || !detail) return;
    const threadId = detail.thread.id;
    const epoch = viewEpoch.current;
    const all = detail.runtime.skills.map((skill) => skill.id);
    const next = nextEnabledSkills(all, detail.runtime.enabledSkills, skillId);
    try {
      await bridge.agentWorkspace.update(threadId, { enabledSkills: next });
      const workspace = await bridge.agentWorkspace.get(threadId);
      if (epoch !== viewEpoch.current) return;
      setDetail(workspace);
      await refresh(threadId, epoch);
    } catch (reason) {
      setError(agentWorkspaceError(reason, "无法更新本任务的 Skill 设置。"));
    }
  };

  const resume = (threadId: string) =>
    void act((bridge) => bridge.agentWorkspace.resume(threadId), "无法继续本次运行。");

  const cancel = (threadId: string) =>
    void act((bridge) => bridge.agentWorkspace.cancel(threadId), "无法取消本次运行。");

  const update = async (thread: AgentThread, patch: UpdateAgentThreadInput) => {
    const bridge = api();
    if (!bridge?.agentWorkspace) return;
    try {
      await bridge.agentWorkspace.update(thread.id, patch);
      if (patch.status === "archived" && detail?.thread.id === thread.id) {
        viewEpoch.current += 1;
        setDetail(null);
      }
      await refresh();
    } catch (reason) { setError(agentWorkspaceError(reason, "无法更新任务。")); }
  };

  const remove = async (thread: AgentThread) => {
    const bridge = api();
    if (!bridge?.agentWorkspace) return;
    try {
      await bridge.agentWorkspace.remove(thread.id);
      if (detail?.thread.id === thread.id) {
        viewEpoch.current += 1;
        setDetail(null);
      }
      await refresh();
    } catch (reason) { setError(agentWorkspaceError(reason, "无法删除任务。")); }
  };

  const selectDirectory = async () => {
    const bridge = api();
    if (!bridge?.agentWorkspace || !detail) return;
    const threadId = detail.thread.id;
    const epoch = viewEpoch.current;
    try {
      const workspace = await bridge.agentWorkspace.selectDirectory(threadId);
      if (epoch !== viewEpoch.current) return;
      setDetail(workspace);
      await refresh(threadId, epoch);
    } catch (reason) { setError(agentWorkspaceError(reason, "无法选择工作目录。")); }
  };

  return (
    <section className={styles.workspace}>
      <ThreadSidebar threads={threads} selectedId={detail?.thread.id} query={query} onQueryChange={setQuery}
        onNew={startNew} onOpen={(id) => void open(id)} onUpdate={(thread, patch) => void update(thread, patch)}
        onDelete={(thread) => void remove(thread)} />
      <main className={styles.main}>
        {error && (
          <div className={styles.error} role="alert">
            <CircleAlert size={14} aria-hidden />
            <div className={styles.errorBody}>
              <p className={styles.errorMessage}>{error.message}</p>
              {error.hint && <p className={styles.errorHint}>{error.hint}</p>}
            </div>
            <button type="button" className={styles.errorClose} aria-label="关闭提示" onClick={() => setError(null)}>
              <X size={13} />
            </button>
          </div>
        )}
        {loading ? <div className={styles.loading}>正在加载智能体任务…</div>
          : detail ? (
            <AgentThreadView detail={detail} sending={sending} pending={pending}
              onSend={(content) => void send(content)} onSelectDirectory={() => void selectDirectory()}
              onApprove={approve} onReject={reject} onReconcile={reconcile}
              onOpenArtifact={(receiptId, mode) => void openArtifact(receiptId, mode)}
              onToggleSkill={(skillId) => void toggleSkill(skillId)}
              onResume={resume} onCancel={cancel} />
          )
            : <AgentHome key={homeKey} model={model} busy={sending} capabilities={capabilities} onStart={(prompt) => void start(prompt)} />}
      </main>
    </section>
  );
}
