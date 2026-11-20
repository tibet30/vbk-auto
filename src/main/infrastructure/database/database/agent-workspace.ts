import type Database from "better-sqlite3";
import type {
  AgentThreadMessageRole,
  AgentThreadSummary,
  CreateAgentThreadInput,
  UpdateAgentThreadInput,
} from "../../../../shared/contracts-agent-workspace.js";
import {
  addAgentThreadMessage,
  createAgentThread,
  deleteAgentThread,
  getAgentThread,
  getAgentThreadDetail,
  listAgentThreadMessages,
  listAgentThreads,
  markAgentThreadRead,
  updateAgentThread,
} from "../parts/agent-workspace.js";

export const agentWorkspaceMethods = {
  createAgentThread(this: { db: Database.Database }, ownerUserId: number, input: CreateAgentThreadInput) {
    return createAgentThread(this.db, ownerUserId, input);
  },
  getAgentThread(this: { db: Database.Database }, ownerUserId: number, id: string) {
    return getAgentThread(this.db, ownerUserId, id);
  },
  listAgentThreads(this: { db: Database.Database }, ownerUserId: number) {
    return listAgentThreads(this.db, ownerUserId);
  },
  deleteAgentThread(this: { db: Database.Database }, ownerUserId: number, id: string) {
    deleteAgentThread(this.db, ownerUserId, id);
  },
  updateAgentThread(
    this: { db: Database.Database },
    ownerUserId: number,
    id: string,
    patch: UpdateAgentThreadInput & { summary?: AgentThreadSummary; runtimeStatus?: import("../../../../shared/contracts-agent-workspace.js").AgentThreadStatus },
  ) {
    return updateAgentThread(this.db, ownerUserId, id, patch);
  },
  addAgentThreadMessage(
    this: { db: Database.Database },
    ownerUserId: number,
    threadId: string,
    role: AgentThreadMessageRole,
    content: string,
  ) {
    return addAgentThreadMessage(this.db, ownerUserId, threadId, role, content);
  },
  listAgentThreadMessages(this: { db: Database.Database }, ownerUserId: number, threadId: string) {
    return listAgentThreadMessages(this.db, ownerUserId, threadId);
  },
  getAgentThreadDetail(this: { db: Database.Database }, ownerUserId: number, id: string) {
    return getAgentThreadDetail(this.db, ownerUserId, id);
  },
  markAgentThreadRead(this: { db: Database.Database }, ownerUserId: number, id: string) {
    markAgentThreadRead(this.db, ownerUserId, id);
  },
} as const;

