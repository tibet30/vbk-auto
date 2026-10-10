/**
 * vehicle-resource-api 的 segment / 资源组小 helper：
 *   - groupIdOf：取一个 resourceGroup 的 ID（兼容 resourceGroupId / resourceGroup.resourceGroupId）；
 *   - hasResourceGroup：segment 是否已绑定某个资源组；
 *   - resourceGroupDrafts：把 VBK 返回的完整资源组 DTO 裁成 saveSegment 协议所需最小集；
 *   - withoutResourceGroup：把某个资源组从 segment 的绑定里剔除；
 *   - segmentsFromPayload：从 getSegments 响应里取段（formalOnly 时只取 productSegments）。
 */

import type { Segment } from "./types.js";

export function segmentsFromPayload(payload: any, options: { formalOnly?: boolean } = {}): Segment[] {
  if (options.formalOnly) return payload?.productSegments?.segments ?? [];
  return payload?.draftProductSegments?.segments
    ?? payload?.productSegments?.segments
    ?? [];
}

export function groupIdOf(value: any): string {
  return String(value?.resourceGroupId ?? value?.resourceGroup?.resourceGroupId ?? "");
}

export function hasResourceGroup(segment: Segment, groupId: string) {
  return Array.isArray(segment.segmentResourceGroups)
    && segment.segmentResourceGroups.some((group: any) => groupIdOf(group) === groupId);
}

/**
 * VBK 资源编辑器只提交资源组 ID、排序和供应商 ID。回传的完整资源组
 * DTO 会让 saveSegment 把旧关联合并回来，特别是在交通子产品的草稿上。
 */
export function resourceGroupDrafts(groups: unknown): Segment["segmentResourceGroups"] {
  if (!Array.isArray(groups)) return [];
  return groups
    .filter((group) => Number.isInteger(Number(groupIdOf(group))) && Number(groupIdOf(group)) > 0)
    .map((group, sort) => ({
      resourceGroupId: Number(groupIdOf(group)),
      sort,
      resourceGroup: { vendorId: group?.resourceGroup?.vendorId ?? null },
    }));
}

export function withoutResourceGroup(segment: Segment, groupId: string): Segment {
  return {
    ...segment,
    segmentResourceGroups: resourceGroupDrafts((Array.isArray(segment.segmentResourceGroups)
      ? segment.segmentResourceGroups
      : []).filter((group: any) => groupIdOf(group) !== groupId)),
  };
}