/**
 * Tibet Extension VBK 绑定契约（400 / 管家 / 最近使用账号）。
 * 权威存储在 Tibet tblExtensionVbkBinding；桌面侧通过 HTTP 同步。
 */

export interface VbkBindingButler {
  contactCardId: number;
  displayName: string;
  providerId: number;
}

export interface VbkBinding {
  vbkAccountKey: string;
  vbkAccountName: string;
  providerId?: number | null;
  servicePhone: string;
  butler: VbkBindingButler | null;
  lastUsedAt?: string | null;
  updatedAt?: string | null;
}

export interface VbkBindingsSnapshot {
  items: VbkBinding[];
  activeVbkAccountKey: string | null;
}

export type VbkBindingUpsertPatch = Partial<{
  vbkAccountName: string;
  providerId: number | null;
  servicePhone: string | null;
  butler: VbkBindingButler | null;
}>;

export interface TibetVbkBindingService {
  list(): Promise<VbkBindingsSnapshot>;
  upsert(vbkAccountKey: string, patch: VbkBindingUpsertPatch): Promise<VbkBinding>;
  activate(vbkAccountKey: string): Promise<VbkBinding>;
  delete(vbkAccountKey: string): Promise<void>;
}
