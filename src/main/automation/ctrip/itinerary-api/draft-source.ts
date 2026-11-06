import { assertRetainedVersion, linkedVersionId } from "./versioning.js";

const retained = ["tourInfoId", "auditTourInfoId", "previewTourInfoId", "auditTourInfoStatus", "auditStatus"] as const;

/**
 * Normal UI save captured on 2026-10-03: check(2) copies this approved source.
 * draftTourInfoStatus 只决定 VBK 页面是否展示草稿入口（1 有草稿 / 2 无草稿，审核解锁后
 * 即为 2）；页面「保存草稿」对两者走同一条 check(2) 路径，故不参与来源判定。
 */
export function approvedFormalDraftSource(info: Record<string, unknown>): string | number | undefined {
  const id = linkedVersionId(info, "tourInfoId");
  const status = info.auditStatus as { key?: unknown } | undefined;
  const draftStatus = String(info.draftTourInfoStatus);
  return !linkedVersionId(info, "draftTourInfoId") && id
    && id === linkedVersionId(info, "auditTourInfoId")
    && status?.key === "A" && String(info.auditTourInfoStatus) === "2"
    && (draftStatus === "1" || draftStatus === "2") ? id : undefined;
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
