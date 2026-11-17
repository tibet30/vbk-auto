import { useCallback, useEffect, useState } from "react";
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
import styles from "./workspace.module.less";

type Bridge = NonNullable<ReturnType<typeof api>>;

export function AgentWorkspacePage({ model }: { model: AppModel }) {
  const [threads, setThreads] = useState<AgentThread[]>([]);
  const [detail, setDetail] = useState<AgentThreadWorkspace | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<AgentCapabilities>();

  const refresh = useCallback(async (preferredId?: string) => {
    const bridge = api();
    if (!bridge?.agentWorkspace) { setLoading(false); return; }
    try {
      const next = await bridge.agentWorkspace.list();
      setThreads(next);
      const id = preferredId ?? detail?.thread.id;
      if (id && next.some((thread) => thread.id === id)) setDetail(await bridge.agentWorkspace.get(id));
      else if (detail && !next.some((thread) => thread.id === detail.thread.id)) setDetail(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法加载智能体任务。");
    } finally { setLoading(false); }
  }, [detail?.thread.id]);

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    const bridge = api();
    if (!bridge?.agentWorkspace) return;
    void bridge.agentWorkspace.capabilities().then(setCapabilities).catch(() => setCapabilities(undefined));
  }, []);

  const open = async (id: string) => {
    const bridge = api();
    if (!bridge?.agentWorkspace) return;
    setError(null);
    try { setDetail(await bridge.agentWorkspace.get(id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法打开任务。"); }
  };

  const createEmpty = async () => {
    const bridge = api();
    if (!bridge?.agentWorkspace) return;
    setError(null);
    try {
      const thread = await bridge.agentWorkspace.create();
      await refresh(thread.id);
      setDetail(await bridge.agentWorkspace.get(thread.id));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法创建任务。"); }
  };

  const start = async (prompt: string) => {
    const bridge = api();
    if (!bridge?.agentWorkspace || sending) return;
    setSending(true);
    setError(null);
    try {
      const thread = await bridge.agentWorkspace.create();
      setDetail(await bridge.agentWorkspace.get(thread.id));
      await refresh(thread.id);
      const next = await bridge.agentWorkspace.send(thread.id, prompt);
      setDetail(next);
      await refresh(thread.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "任务执行失败。"); }
    finally { setSending(false); }
  };

  const send = async (content: string) => {
    const bridge = api();
    if (!bridge?.agentWorkspace || !detail || sending) return;
    setSending(true);
    setError(null);
    try {
      setDetail(await bridge.agentWorkspace.send(detail.thread.id, content));
      await refresh(detail.thread.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "任务执行失败。");
      await refresh(detail.thread.id);
    } finally { setSending(false); }
  };

  // 审批 / 拒绝 / 取消：都是同一个 main 进程往返，成功后用返回的工作区事实覆盖本地状态。
  const act = async (
    call: (bridge: Bridge, threadId: string) => Promise<AgentThreadWorkspace>,
    fallback: string,
  ) => {
    const bridge = api();
    if (!bridge?.agentWorkspace || !detail || pending) return;
    const threadId = detail.thread.id;
    setPending(true);
    setError(null);
    try {
      setDetail(await call(bridge, threadId));
      await refresh(threadId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : fallback);
      await refresh(threadId);
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
      setError(reason instanceof Error ? reason.message : "无法打开产物。");
    }
  };

  const toggleSkill = async (skillId: string) => {
    const bridge = api();
    if (!bridge?.agentWorkspace || !detail) return;
    const all = detail.runtime.skills.map((skill) => skill.id);
    const next = nextEnabledSkills(all, detail.runtime.enabledSkills, skillId);
    try {
      await bridge.agentWorkspace.update(detail.thread.id, { enabledSkills: next });
      setDetail(await bridge.agentWorkspace.get(detail.thread.id));
      await refresh(detail.thread.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法更新本任务的 Skill 设置。");
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
      if (patch.status === "archived" && detail?.thread.id === thread.id) setDetail(null);
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法更新任务。"); }
  };

  const selectDirectory = async () => {
    const bridge = api();
    if (!bridge?.agentWorkspace || !detail) return;
    try {
      setDetail(await bridge.agentWorkspace.selectDirectory(detail.thread.id));
      await refresh(detail.thread.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法选择工作目录。"); }
  };

  return (
    <section className={styles.workspace}>
      <ThreadSidebar threads={threads} selectedId={detail?.thread.id} query={query} onQueryChange={setQuery}
        onNew={() => void createEmpty()} onOpen={(id) => void open(id)} onUpdate={(thread, patch) => void update(thread, patch)} />
      <main className={styles.main}>
        {error && <div className={styles.error} role="alert">{error}</div>}
        {loading ? <div className={styles.loading}>正在加载智能体任务…</div>
          : detail ? (
            <AgentThreadView detail={detail} sending={sending} pending={pending}
              onSend={(content) => void send(content)} onSelectDirectory={() => void selectDirectory()}
              onApprove={approve} onReject={reject} onReconcile={reconcile}
              onOpenArtifact={(receiptId, mode) => void openArtifact(receiptId, mode)}
              onToggleSkill={(skillId) => void toggleSkill(skillId)}
              onResume={resume} onCancel={cancel} />
          )
            : <AgentHome model={model} busy={sending} capabilities={capabilities} onStart={(prompt) => void start(prompt)} />}
      </main>
    </section>
  );
}
