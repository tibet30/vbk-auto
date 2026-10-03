export type WritableTourInfoField = "draftTourInfoId" | "previewTourInfoId" | "tourInfoId";

export interface WritableTourInfoVersion {
  id: string | number;
  field: WritableTourInfoField;
}

export function linkedVersionId(tourInfo: Record<string, unknown>, field: string): string | number | undefined {
  const value = tourInfo[field];
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const id = String(value).trim();
  return /^[1-9]\d*$/.test(id) ? id : undefined;
}

export function linkedVersionSummary(tourInfo: Record<string, unknown>): string {
  const fields = [
    "tourInfoId",
    "draftTourInfoId",
    "draftTourInfoStatus",
    "auditTourInfoId",
    "auditTourInfoStatus",
    "previewTourInfoId",
    "auditStatus",
  ];
  const summary = Object.fromEntries(fields.map((field) => {
    const value = tourInfo[field];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return [field, {
        key: (value as Record<string, unknown>).key ?? null,
        value: (value as Record<string, unknown>).value ?? null,
      }];
    }
    return [field, value ?? null];
  }));
  return JSON.stringify(summary);
}

export function isUnsubmittedAuditStatus(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  return status.key === "N" || /未提交/.test(String(status.value ?? ""));
}

export function writableTourInfoVersion(tourInfo: Record<string, unknown>): WritableTourInfoVersion | undefined {
  const draftTourInfoId = linkedVersionId(tourInfo, "draftTourInfoId");
  const previewTourInfoId = linkedVersionId(tourInfo, "previewTourInfoId");
  const formalTourInfoId = linkedVersionId(tourInfo, "tourInfoId");
  const auditTourInfoId = linkedVersionId(tourInfo, "auditTourInfoId");
  const draftAliases = [formalTourInfoId, auditTourInfoId, previewTourInfoId].filter(Boolean);
  if (draftTourInfoId && !draftAliases.some((id) => id === draftTourInfoId)) {
    return { id: draftTourInfoId, field: "draftTourInfoId" };
  }
  const isPreviewOnlyInitialDraft = !draftTourInfoId
    && !formalTourInfoId
    && !auditTourInfoId
    && Boolean(previewTourInfoId)
    && isUnsubmittedAuditStatus(tourInfo.auditStatus);
  if (isPreviewOnlyInitialDraft) return { id: previewTourInfoId!, field: "previewTourInfoId" };
  const isUnsubmittedCurrentDraft = formalTourInfoId
    && formalTourInfoId === auditTourInfoId
    && isUnsubmittedAuditStatus(tourInfo.auditStatus);
  if (isUnsubmittedCurrentDraft) return { id: formalTourInfoId, field: "tourInfoId" };
  return undefined;
}

export function sameField(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function assertRetainedVersion(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  field: "tourInfoId" | "auditTourInfoId" | "previewTourInfoId" | "auditTourInfoStatus" | "auditStatus",
): void {
  if (before[field] !== undefined && !sameField(before[field], after[field])) {
    throw new Error(`VBK 草稿关联保存后 ${field} 发生未授权变化，已停止回读验收。`);
  }
}
