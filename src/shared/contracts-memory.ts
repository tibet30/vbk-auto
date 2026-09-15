/** 本地用户记忆系统契约。 */
/**
 * 本地记忆系统：记录“明确记住”或可恢复的常用偏好。
 */

export type UserMemoryKind = "explicit" | "inferred";

export type UserMemoryScopeType = "global" | "product";

export type UserMemoryStatus = "active" | "pending" | "inactive" | "archived" | "superseded";

export interface UserMemoryEvidence {
  id: string;
  sourceEventId?: string;
  sourceKind: string;
  taskId?: string;
  rawExcerpt?: string;
  createdAt: string;
}

export interface UserMemory {
  id: string;
  ownerUserId: number;
  scopeType: UserMemoryScopeType;
  scopeKey: string;
  kind: UserMemoryKind;
  topic: string;
  preferenceKey?: string;
  content: string;
  conditions: string[];
  status: UserMemoryStatus;
  revision: number;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
  lastEvidenceAt?: string;
  lastUsedAt?: string;
}

export type MemoryRecord = UserMemory;

export interface MemoryInput {
  ownerUserId: number;
  scopeType?: UserMemoryScopeType;
  scopeKey?: string;
  kind: UserMemoryKind;
  topic: string;
  content: string;
  preferenceKey?: string;
  conditions?: string[];
  status?: UserMemoryStatus;
  sourceKind?: string;
  sourceEventId?: string;
  taskId?: string;
  rawExcerpt?: string;
}

export interface MemoryFilter {
  status?: UserMemoryStatus[];
  scopeType?: UserMemoryScopeType;
  scopeKey?: string;
  includeInactive?: boolean;
  limit?: number;
  offset?: number;
  order?: "updated" | "evidence";
}

export interface MemoryPatch {
  topic?: string;
  preferenceKey?: string;
  content?: string;
  conditions?: string[];
  status?: UserMemoryStatus;
  supersededBy?: string;
}

export interface MemoryMaintenanceSettings {
  autoCapture?: boolean;
  scopeKey?: string | null;
}

export interface MemoryMaintenanceResult {
  ran: boolean;
  archivedCount: number;
  prunedCount: number;
  promotedCount: number;
  total: number;
  truncated: boolean;
}

export interface MemoryPromptContext {
  scope: UserMemoryScopeType;
  scopeKey: string | null;
  maxItems: number;
  maxTokens: number;
  skipped: number;
  lines: string[];
  budgets: {
    usedTokens: number;
    budgetTokens: number;
  };
}

export interface UserMemoryInput extends MemoryInput {
  /** 与旧命名兼容，保留 MemoryInput 作为别名。 */
  kind: UserMemoryKind;
}

export interface MemorySaveResult {
  inserted: boolean;
  existed: boolean;
  note: string;
  memory: UserMemory;
}

export interface MemoryMaintenanceState {
  ownerUserId: number;
  autoCapture: boolean;
  scopeKey: string | null;
  lastTaskId: string | null;
  pendingCount: number;
  lastSuccessAt: string | null;
  updatedAt: string;
}
