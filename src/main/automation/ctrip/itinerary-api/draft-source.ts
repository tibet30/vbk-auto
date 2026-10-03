import { assertRetainedVersion, linkedVersionId } from "./versioning.js";

const retained = ["tourInfoId", "auditTourInfoId", "previewTourInfoId", "auditTourInfoStatus", "auditStatus"] as const;

/** Normal UI save captured on 2026-10-03: check(2) copies this approved source. */
export function approvedFormalDraftSource(info: Record<string, unknown>): string | number | undefined {
  const id = linkedVersionId(info, "tourInfoId");
  const status = info.auditStatus as { key?: unknown } | undefined;
  return !linkedVersionId(info, "draftTourInfoId") && id
    && id === linkedVersionId(info, "auditTourInfoId")
    && status?.key === "A" && String(info.auditTourInfoStatus) === "2"
    && String(info.draftTourInfoStatus) === "1" ? id : undefined;
}

/** No detail or association write may target the source or an invented draft ID. */
export function assertCreatedDraftRelation(
  before: Record<string, unknown>, after: Record<string, unknown> | undefined,
  detailId: string | number | undefined,
): void {
  const draft = after && linkedVersionId(after, "draftTourInfoId");
  const aliases = retained.slice(0, 3).map((key) => linkedVersionId(before, key));
  if (!after || !draft || draft !== detailId || aliases.includes(draft)
    || String(after.draftTourInfoStatus) !== "1") {
    throw new Error("VBK check(2) 未返回与详情一致的独立草稿版本，未发送详情或关联保存。");
  }
  for (const field of retained) assertRetainedVersion(before, after, field);
}
