/**
 * VbkDatabase user_memories + ctrip-poi-availability-cache 部分：
 *   - saveUserMemory / listUserMemories / getUserMemory /
 *     updateUserMemory / disableUserMemory / deleteUserMemory /
 *     markMemoryUsed
 *   - addMemoryEvidence / listMemoryEvidence
 *   - getMemoryMaintenanceState / createOrUpdateMemoryState /
 *     bumpMemoryMaintenanceCursor / clearMemoryMaintenancePending /
 *     markMemorySuccess / getMemoryByTopic
 *   - getCachedCtripPoiAvailability / saveCachedCtripPoiAvailability
 *
 * 实现策略：方法集合对象；database.ts 用 Object.assign 合并到 VbkDatabase。
 */

import type {
  MemoryFilter,
  MemoryInput,
  MemoryPatch,
  MemorySaveResult,
  UserMemory,
  UserMemoryEvidence,
  MemoryMaintenanceState,
} from "../../../../shared/contracts.js";
import type Database from "better-sqlite3";
import {
  getCachedCtripPoiAvailability,
  saveCachedCtripPoiAvailability,
  type CachedCtripPoiAvailability,
} from "../parts/ctrip-poi-availability-cache.js";
import {
  addMemoryEvidence,
  bumpMemoryMaintenanceCursor,
  clearMemoryMaintenancePending,
  createOrUpdateMemoryState,
  deleteUserMemory,
  disableUserMemory,
  getMemoryByTopic,
  getMemoryMaintenanceState,
  getUserMemory,
  listMemoryEvidence,
  listUserMemories,
  markMemorySuccess,
  markMemoryUsed,
  saveUserMemory,
  updateUserMemory,
} from "../parts/memory.js";

export const memoryMethods = {
  saveUserMemory(this: { db: Database.Database }, input: MemoryInput): MemorySaveResult { return saveUserMemory(this.db, input); },
  listUserMemories(this: { db: Database.Database }, ownerUserId: number, filter: MemoryFilter = {}): UserMemory[] { return listUserMemories(this.db, ownerUserId, filter); },
  getUserMemory(this: { db: Database.Database }, ownerUserId: number, id: string): UserMemory | undefined { return getUserMemory(this.db, ownerUserId, id); },
  updateUserMemory(this: { db: Database.Database }, ownerUserId: number, id: string, patch: MemoryPatch): UserMemory { return updateUserMemory(this.db, ownerUserId, id, patch); },
  disableUserMemory(this: { db: Database.Database }, ownerUserId: number, id: string): UserMemory { return disableUserMemory(this.db, ownerUserId, id); },
  deleteUserMemory(this: { db: Database.Database }, ownerUserId: number, id: string): void { deleteUserMemory(this.db, ownerUserId, id); },
  markMemoryUsed(this: { db: Database.Database }, ownerUserId: number, id: string): void { markMemoryUsed(this.db, ownerUserId, id); },
  addMemoryEvidence(this: { db: Database.Database }, input: Parameters<typeof addMemoryEvidence>[1]): UserMemoryEvidence { return addMemoryEvidence(this.db, input); },
  listMemoryEvidence(this: { db: Database.Database }, ownerUserId: number, memoryId: string): UserMemoryEvidence[] { return listMemoryEvidence(this.db, ownerUserId, memoryId); },
  getMemoryMaintenanceState(this: { db: Database.Database }, ownerUserId: number): MemoryMaintenanceState { return getMemoryMaintenanceState(this.db, ownerUserId); },
  createOrUpdateMemoryState(this: { db: Database.Database }, ownerUserId: number, patch: Parameters<typeof createOrUpdateMemoryState>[2]): void { createOrUpdateMemoryState(this.db, ownerUserId, patch); },
  bumpMemoryMaintenanceCursor(this: { db: Database.Database }, ownerUserId: number, cursorTaskId?: string): void { bumpMemoryMaintenanceCursor(this.db, ownerUserId, cursorTaskId); },
  clearMemoryMaintenancePending(this: { db: Database.Database }, ownerUserId: number): void { clearMemoryMaintenancePending(this.db, ownerUserId); },
  markMemorySuccess(this: { db: Database.Database }, ownerUserId: number): void { markMemorySuccess(this.db, ownerUserId); },
  getMemoryByTopic(this: { db: Database.Database }, ownerUserId: number, topic: string): UserMemory[] { return getMemoryByTopic(this.db, ownerUserId, topic); },
  getCachedCtripPoiAvailability(this: { db: Database.Database }, poiId: number): CachedCtripPoiAvailability | undefined { return getCachedCtripPoiAvailability(this.db, poiId); },
  saveCachedCtripPoiAvailability(this: { db: Database.Database }, entry: CachedCtripPoiAvailability): void { saveCachedCtripPoiAvailability(this.db, entry); },
} as const;