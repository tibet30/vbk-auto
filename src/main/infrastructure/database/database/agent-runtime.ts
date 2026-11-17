import type Database from "better-sqlite3";
import type { AgentApprovalScope, AgentRun, AgentRunStatus, AgentToolCallStatus } from "../../../../shared/contracts-agent-runtime.js";
import {
  createAgentPermissionGrant,
  findAgentActionReceiptByIdempotencyKey,
  getAgentActionReceipt,
  listAgentActionReceipts,
  listAgentPermissionGrants,
  markAgentActionReceiptReconciled,
  revokeAgentPermissionGrants,
  saveAgentActionReceipt,
} from "../parts/agent-runtime-approval.js";
import {
  createAgentRun,
  findActiveAgentRun,
  findAgentToolCallByIdempotencyKey,
  getAgentRun,
  getAgentRunTranscript,
  getAgentToolCall,
  insertAgentToolCall,
  listAgentRuns,
  listAgentToolCalls,
  listAgentToolCallsByThread,
  markInterruptedAgentToolCallsUncertain,
  recoverInterruptedAgentRuns,
  saveAgentRunTranscript,
  updateAgentRun,
  updateAgentToolCall,
  type AgentTranscriptEntry,
} from "../parts/agent-runtime.js";

type Db = { db: Database.Database };

export const agentRuntimeMethods = {
  // runs
  createAgentRun(this: Db, ownerUserId: number, input: { threadId: string; intent: string; maxSteps?: number }): AgentRun {
    return createAgentRun(this.db, ownerUserId, input);
  },
  getAgentRun(this: Db, ownerUserId: number, id: string) {
    return getAgentRun(this.db, ownerUserId, id);
  },
  listAgentRuns(this: Db, ownerUserId: number, threadId: string, limit?: number) {
    return listAgentRuns(this.db, ownerUserId, threadId, limit);
  },
  findActiveAgentRun(this: Db, ownerUserId: number, threadId: string) {
    return findActiveAgentRun(this.db, ownerUserId, threadId);
  },
  updateAgentRun(
    this: Db,
    ownerUserId: number,
    id: string,
    patch: { status?: AgentRunStatus; step?: number; maxSteps?: number; error?: string | null; completedAt?: string | null },
  ) {
    return updateAgentRun(this.db, ownerUserId, id, patch);
  },
  getAgentRunTranscript(this: Db, ownerUserId: number, runId: string): AgentTranscriptEntry[] {
    return getAgentRunTranscript(this.db, ownerUserId, runId);
  },
  saveAgentRunTranscript(this: Db, ownerUserId: number, runId: string, transcript: readonly AgentTranscriptEntry[]) {
    saveAgentRunTranscript(this.db, ownerUserId, runId, transcript);
  },

  // tool calls
  insertAgentToolCall(
    this: Db,
    ownerUserId: number,
    input: Parameters<typeof insertAgentToolCall>[2],
  ) {
    return insertAgentToolCall(this.db, ownerUserId, input);
  },
  getAgentToolCall(this: Db, ownerUserId: number, id: string) {
    return getAgentToolCall(this.db, ownerUserId, id);
  },
  findAgentToolCallByIdempotencyKey(this: Db, idempotencyKey: string) {
    return findAgentToolCallByIdempotencyKey(this.db, idempotencyKey);
  },
  updateAgentToolCall(
    this: Db,
    ownerUserId: number,
    id: string,
    patch: {
      status?: AgentToolCallStatus;
      error?: string | null;
      receiptId?: string | null;
      targetKey?: string | null;
      summary?: string;
      diff?: string | null;
    },
  ) {
    return updateAgentToolCall(this.db, ownerUserId, id, patch);
  },
  listAgentToolCalls(this: Db, ownerUserId: number, runId: string) {
    return listAgentToolCalls(this.db, ownerUserId, runId);
  },
  listAgentToolCallsByThread(this: Db, ownerUserId: number, threadId: string, limit?: number) {
    return listAgentToolCallsByThread(this.db, ownerUserId, threadId, limit);
  },
  markInterruptedAgentToolCallsUncertain(this: Db, detail: string) {
    return markInterruptedAgentToolCallsUncertain(this.db, detail);
  },
  recoverInterruptedAgentRuns(this: Db, detail: string) {
    return recoverInterruptedAgentRuns(this.db, detail);
  },

  // grants
  createAgentPermissionGrant(
    this: Db,
    ownerUserId: number,
    input: {
      threadId: string;
      runId: string;
      toolCallId: string;
      scope: AgentApprovalScope;
      action: string;
      targetKey: string;
      accountKey: string;
    },
  ) {
    return createAgentPermissionGrant(this.db, ownerUserId, input);
  },
  listAgentPermissionGrants(this: Db, ownerUserId: number, threadId: string) {
    return listAgentPermissionGrants(this.db, ownerUserId, threadId);
  },
  revokeAgentPermissionGrants(this: Db, ownerUserId: number, threadId: string, reason: string) {
    return revokeAgentPermissionGrants(this.db, ownerUserId, threadId, reason);
  },

  // receipts
  saveAgentActionReceipt(this: Db, ownerUserId: number, input: Parameters<typeof saveAgentActionReceipt>[2]) {
    return saveAgentActionReceipt(this.db, ownerUserId, input);
  },
  getAgentActionReceipt(this: Db, ownerUserId: number, id: string) {
    return getAgentActionReceipt(this.db, ownerUserId, id);
  },
  markAgentActionReceiptReconciled(
    this: Db,
    ownerUserId: number,
    id: string,
    input: Parameters<typeof markAgentActionReceiptReconciled>[3],
  ) {
    return markAgentActionReceiptReconciled(this.db, ownerUserId, id, input);
  },
  findAgentActionReceiptByIdempotencyKey(this: Db, idempotencyKey: string) {
    return findAgentActionReceiptByIdempotencyKey(this.db, idempotencyKey);
  },
  listAgentActionReceipts(this: Db, ownerUserId: number, threadId: string, limit?: number) {
    return listAgentActionReceipts(this.db, ownerUserId, threadId, limit);
  },
} as const;
