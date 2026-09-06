import type {
  MemoryFilter,
  MemoryInput,
  MemoryMaintenanceResult,
  MemoryMaintenanceSettings,
  MemoryMaintenanceState,
  MemoryPatch,
  MemoryPromptContext,
  MemorySaveResult,
  UserMemory,
  UserMemoryEvidence,
  UserMemoryScopeType,
} from "../../shared/contracts.js";
import { logWarn } from "../../shared/log-timestamp.js";
import type { VbkDatabase } from "../infrastructure/database/database.js";
import { parseExplicitMemoryIntent } from "./memory-parser.js";

export interface MemoryServiceOptions {
  db: VbkDatabase;
  getOwnerUserId: () => number | null;
}

export interface CaptureMemoryOptions {
  localProductId?: string;
  sourceKind?: string;
  sourceEventId?: string;
  taskId?: string;
}

function inferCaptureScope(content: string, localProductId?: string): { scopeType: "global" | "product"; scopeKey: string } {
  if (localProductId && /本产品|这个产品|当前产品|这条线路|当前方案|本方案|这次方案|这次产品/u.test(content)) {
    return { scopeType: "product", scopeKey: localProductId };
  }
  return { scopeType: "global", scopeKey: "global" };
}

export class MemoryService {
  constructor(private readonly options: MemoryServiceOptions) {}

  ownerUserId(): number {
    const owner = this.options.getOwnerUserId();
    if (!Number.isInteger(owner) || owner == null || owner <= 0) {
      throw new Error("请先登录应用账号后再保存记忆。");
    }
    return owner;
  }

  captureExplicitFromUserMessage(
    content: string,
    options: CaptureMemoryOptions = {},
  ): MemorySaveResult | undefined {
    const intent = parseExplicitMemoryIntent(content);
    if (!intent.shouldCapture) return undefined;
    // Soft-fail: memory is a side effect and must never block agent/chat turns
    // (e.g. missing app-auth owner, transient SQLite errors).
    try {
      const scope = inferCaptureScope(intent.content, options.localProductId);
      return this.saveExplicit({
        ...scope,
        topic: intent.topic,
        preferenceKey: intent.preferenceKey,
        content: intent.content,
        conditions: intent.conditions,
        sourceKind: options.sourceKind ?? "user",
        sourceEventId: options.sourceEventId,
        taskId: options.taskId,
        rawExcerpt: intent.raw,
      });
    } catch (error) {
      logWarn("[memory] explicit capture skipped", {
        sourceKind: options.sourceKind,
        localProductId: options.localProductId,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  saveExplicit(input: Omit<MemoryInput, "ownerUserId" | "kind">): MemorySaveResult {
    const ownerUserId = this.ownerUserId();
    return this.options.db.saveUserMemory({
      ...input,
      ownerUserId,
      kind: "explicit",
      scopeType: input.scopeType ?? "global",
      scopeKey: input.scopeKey ?? "global",
      status: input.status ?? "active",
    });
  }

  list(filter: MemoryFilter = {}): UserMemory[] {
    return this.options.db.listUserMemories(this.ownerUserId(), filter);
  }

  get(id: string): UserMemory | undefined {
    return this.options.db.getUserMemory(this.ownerUserId(), id);
  }

  update(id: string, patch: MemoryPatch): UserMemory {
    return this.options.db.updateUserMemory(this.ownerUserId(), id, patch);
  }

  disable(id: string): UserMemory {
    return this.options.db.disableUserMemory(this.ownerUserId(), id);
  }

  delete(id: string): void {
    this.options.db.deleteUserMemory(this.ownerUserId(), id);
  }

  evidence(memoryId: string): UserMemoryEvidence[] {
    return this.options.db.listMemoryEvidence(this.ownerUserId(), memoryId);
  }

  settings(settings?: MemoryMaintenanceSettings): MemoryMaintenanceState {
    const ownerUserId = this.ownerUserId();
    if (settings) {
      this.options.db.createOrUpdateMemoryState(ownerUserId, {
        ...(settings.autoCapture !== undefined ? { auto_capture: settings.autoCapture ? 1 : 0 } : {}),
        ...(settings.scopeKey !== undefined ? { scope_key: settings.scopeKey } : {}),
      });
    }
    return this.options.db.getMemoryMaintenanceState(ownerUserId);
  }

  maintenance(): MemoryMaintenanceResult {
    const ownerUserId = this.ownerUserId();
    const total = this.options.db.listUserMemories(ownerUserId, {
      includeInactive: true,
      limit: 200,
    }).length;
    this.options.db.markMemorySuccess(ownerUserId);
    return {
      ran: true,
      archivedCount: 0,
      prunedCount: 0,
      promotedCount: 0,
      total,
      truncated: total >= 200,
    };
  }

  loadContextMemories(input: {
    localProductId?: string;
    maxItems?: number;
    maxTokens?: number;
  } = {}): MemoryPromptContext {
    const ownerUserId = this.ownerUserId();
    const maxItems = Math.min(Math.max(input.maxItems ?? 8, 1), 20);
    const maxTokens = Math.min(Math.max(input.maxTokens ?? 800, 100), 2000);
    const productMemories = input.localProductId
      ? this.options.db.listUserMemories(ownerUserId, {
          scopeType: "product",
          scopeKey: input.localProductId,
          order: "updated",
          limit: maxItems * 3,
        })
      : [];
    const globalMemories = this.options.db.listUserMemories(ownerUserId, {
      scopeType: "global",
      scopeKey: "global",
      order: "updated",
      limit: maxItems * 3,
    });
    return buildMemoryPromptContext({
      scope: input.localProductId ? "product" : "global",
      scopeKey: input.localProductId ?? null,
      memories: [...productMemories, ...globalMemories],
      maxItems,
      maxTokens,
    });
  }
}

export function buildMemoryPromptContext(input: {
  scope: UserMemoryScopeType;
  scopeKey: string | null;
  memories: UserMemory[];
  maxItems?: number;
  maxTokens?: number;
}): MemoryPromptContext {
  const maxItems = Math.min(Math.max(input.maxItems ?? 8, 1), 20);
  const maxTokens = Math.min(Math.max(input.maxTokens ?? 800, 100), 2000);
  const seen = new Set<string>();
  const lines: string[] = [];
  let usedTokens = 0;

  for (const memory of input.memories) {
    if (!["active", "pending"].includes(memory.status)) continue;
    const identity = `${memory.scopeType}:${memory.scopeKey}:${memory.topic}:${memory.content}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const prefix = memory.scopeType === "product" ? "产品偏好" : "全局偏好";
    const conditions = memory.conditions.length ? `（条件：${memory.conditions.join("；")}）` : "";
    const line = `- ${prefix}/${memory.topic}: ${memory.content}${conditions}`;
    const estimatedTokens = Math.ceil(line.length / 2);
    if (lines.length >= maxItems || usedTokens + estimatedTokens > maxTokens) break;
    lines.push(line);
    usedTokens += estimatedTokens;
  }

  return {
    scope: input.scope,
    scopeKey: input.scopeKey,
    maxItems,
    maxTokens,
    skipped: Math.max(0, input.memories.length - lines.length),
    lines,
    budgets: { usedTokens, budgetTokens: maxTokens },
  };
}
