// 浏览器夹具：用真实智能体工作区页面配内存桥接，供新建任务与最近任务交互回归使用。
import { createRoot } from "react-dom/client";
import { AgentWorkspacePage } from "../../../src/renderer/app/views/agent/index";
import type { AppModel } from "../../../src/renderer/app/app.main.model";
import type { AgentThread, AgentThreadMessage } from "../../../src/shared/contracts-agent-workspace";
import type { AgentThreadWorkspace } from "../../../src/shared/contracts-agent-runtime";
import "../../../src/renderer/styles/tokens.css";
import "../../../src/renderer/styles/global.css";

const now = () => new Date().toISOString();
const owner = 1001;
const threads: AgentThread[] = [];
const messages = new Map<string, AgentThreadMessage[]>();
const counters = { create: 0, send: 0, list: 0, remove: 0 };
const seedCount = Number(new URLSearchParams(window.location.search).get("seed") ?? 0);
let idSeq = 0;
let sendGate: { promise: Promise<void>; release: () => void } | null = null;
let sendFailure: string | null = null;

function makeThread(title: string): AgentThread {
  const thread: AgentThread = {
    id: `thread-${(idSeq += 1)}`,
    ownerUserId: owner,
    title,
    status: "waiting",
    pinned: false,
    unread: false,
    messageCount: 0,
    createdAt: now(),
    updatedAt: now(),
  };
  threads.unshift(thread);
  messages.set(thread.id, []);
  return thread;
}

function workspace(id: string): AgentThreadWorkspace {
  const thread = threads.find((item) => item.id === id);
  if (!thread) throw new Error(`任务不存在：${id}`);
  const list = messages.get(id) ?? [];
  return {
    thread: { ...thread, messageCount: list.length },
    messages: list.map((message) => ({ ...message })),
    runtime: { toolCalls: [], receipts: [], skills: [] },
  };
}

const seeded = makeThread("查我的订单");
messages.get(seeded.id)!.push(
  { id: "m1", threadId: seeded.id, role: "user", content: "查一下我的客户订单", createdAt: now() },
  { id: "m2", threadId: seeded.id, role: "assistant", content: "已按状态列出 3 笔订单。", createdAt: now() },
);
for (let index = 0; index < seedCount; index += 1) makeThread(`历史任务 ${index + 1}`);
counters.create = 0;

const workspaceApi = {
  list: async () => {
    counters.list += 1;
    return threads.map((thread) => ({ ...thread, messageCount: (messages.get(thread.id) ?? []).length }));
  },
  get: async (id: string) => workspace(id),
  create: async () => {
    counters.create += 1;
    return { ...makeThread("新任务") };
  },
  update: async (id: string, patch: Partial<AgentThread>) => {
    const thread = threads.find((item) => item.id === id);
    if (!thread) throw new Error(`任务不存在：${id}`);
    Object.assign(thread, patch, { updatedAt: now() });
    return { ...thread };
  },
  remove: async (id: string) => {
    const index = threads.findIndex((item) => item.id === id);
    if (index < 0) throw new Error(`任务不存在：${id}`);
    threads.splice(index, 1);
    messages.delete(id);
    counters.remove += 1;
  },
  send: async (id: string, content: string) => {
    counters.send += 1;
    const thread = threads.find((item) => item.id === id);
    if (!thread) throw new Error(`任务不存在：${id}`);
    if (thread.title === "新任务") thread.title = content.slice(0, 24);
    messages.get(id)!.push({ id: `m-${counters.send}`, threadId: id, role: "user", content, createdAt: now() });
    thread.updatedAt = now();
    if (sendGate) await sendGate.promise;
    if (sendFailure) {
      const message = sendFailure;
      sendFailure = null;
      throw new Error(message);
    }
    return workspace(id);
  },
  capabilities: async () => ({ skills: [], externalTools: [] }),
  selectDirectory: async (id: string) => workspace(id),
  approve: async (id: string) => workspace(id),
  reject: async (id: string) => workspace(id),
  reconcile: async (id: string) => workspace(id),
  resume: async (id: string) => workspace(id),
  cancel: async (id: string) => workspace(id),
  openArtifact: async () => {},
  previewArtifact: async () => ({ entry: "", html: "", truncated: false }),
};

(window as unknown as { vbk: unknown }).vbk = { agentWorkspace: workspaceApi };
(window as unknown as { __fx: unknown }).__fx = {
  counters,
  titles: () => threads.map((thread) => thread.title),
  threadCount: () => threads.length,
  holdSend: () => {
    let release: () => void = () => {};
    const promise = new Promise<void>((resolve) => { release = resolve; });
    sendGate = { promise, release };
  },
  failNextSend: (message: string) => { sendFailure = message; },
  releaseSend: () => {
    sendGate?.release();
    sendGate = null;
  },
};

const model = {
  startCreateProduct: () => {},
  openProductList: () => {},
  openLogin: () => {},
  setView: () => {},
} as unknown as AppModel;

createRoot(document.getElementById("root")!).render(<AgentWorkspacePage model={model} />);
