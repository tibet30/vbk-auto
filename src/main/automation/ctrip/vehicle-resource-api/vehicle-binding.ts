/**
 * vehicle-resource-api/vehicle-binding：用车资源组绑定主链路。
 *
 *   - vehicleGroup                 构造一个用车资源组 draft（saveSegment 协议）；
 *   - verifyVehicleResourceBinding 读取草稿 / 正式段，确认仅全程首段绑定目标用车组；
 *   - waitForFormalVehicleResourceBinding  提交后异步轮询正式段；
 *   - ensureVehicleResourceGroupDraft     把用车组写入当前草稿并立即回读；
 *   - ensureVehicleResourceBinding        页面操作未落库时的接口回退链路（含提交 + 轮询）；
 *   - ensureVehicleResourceApi            正式自动录入入口（严格只走接口）。
 *
 * 关键约束：
 *   - 用车组只绑定全程首段；saveSegment 异步重排后必须再次读最新快照清理非首段重复绑定；
 *   - 交通边界段（cityId=0 或 cityName "多出发/多到达"）不参与资源组绑定；
 *   - submitSegments 后必须轮询正式段，作为审计证据。
 */

import { productNeedsVehicleResource } from "../../../../shared/product-form.js";
import { finalizeParentResourceSegments } from "../resource-segment-finalization.js";
import type { Segment } from "./types.js";
import type { VehicleResourceBindingOptions } from "./types.js";
import { submitResourceSegmentsApi } from "./segment-apis.js";
import {
  getProductSegmentsApi,
  saveProductSegmentApi,
} from "./segment-apis.js";
import { ensureResourceSegmentsDraftApi } from "./draft-init.js";
import {
  groupIdOf,
  hasResourceGroup,
  resourceGroupDrafts,
  segmentsFromPayload,
  withoutResourceGroup,
} from "./segment-helpers.js";

function vehicleGroup(groupId: string, source: unknown) {
  return {
    resourceGroupId: Number(groupId),
    sort: 0,
    resourceGroup: {
      vendorId: (source as any)?.resourceGroup?.vendorId ?? null,
    },
  };
}

/** 读取 Tour Helper 使用的后端数据，确认仅全程首段绑定目标用车组。 */
export async function verifyVehicleResourceBinding(
  page: any,
  productId: string,
  groupId: number,
  options: { requireFormal?: boolean; payload?: any } = {},
) {
  const payload = options.payload ?? await getProductSegmentsApi(page, productId);
  const all = segmentsFromPayload(payload, { formalOnly: options.requireFormal });
  const matched = all.filter((segment) => hasResourceGroup(segment, String(groupId)));
  const first = fullTripSegmentOf(all);
  return {
    bound: first !== undefined && hasResourceGroup(first, String(groupId)) && matched.length === 1,
    segmentCount: all.length,
    matchedCount: matched.length,
    targetSegmentId: first ? String(first.segmentId) : undefined,
  };
}

/**
 * submitSegments 的 Ack 只代表平台接受了提交，不代表正式资源段已经完成异步结算。
 * 只在提交后轮询正式段；草稿回读仍要求即时一致，避免掩盖实际的草稿写入失败。
 */
async function waitForFormalVehicleResourceBinding(
  page: any,
  productId: string,
  groupId: number,
  options: VehicleResourceBindingOptions,
) {
  const attempts = Math.max(1, options.formalReadbackAttempts ?? 60);
  const intervalMs = Math.max(0, options.formalReadbackIntervalMs ?? 1_500);
  let latest: Awaited<ReturnType<typeof verifyVehicleResourceBinding>> | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    latest = await verifyVehicleResourceBinding(page, productId, groupId, { requireFormal: true });
    if (latest.bound || attempt === attempts) return latest;
    if (intervalMs) await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("正式用车资源段回读未执行");
}

/**
 * 仅把用车组写入当前资源草稿并立即回读。交通子产品会在同一次资源提交中
 * 结算草稿，因此不能先单独 submitSegments，否则会抢先触发"缺少交通段"校验。
 */
export async function ensureVehicleResourceGroupDraft(
  page: any,
  productId: string,
  groupId: number,
  groupName: string,
  options: { verifyDraft?: boolean } = {},
) {
  let changed = false;
  let latest: Segment[] = segmentsFromPayload(await ensureResourceSegmentsDraftApi(page, productId));
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const fullTripSegment = fullTripSegmentOf(latest);
    if (!fullTripSegment) throw new Error("VBK 资源配置未返回任何行程段");
    if (!hasResourceGroup(fullTripSegment, String(groupId))) {
      const source = latest.flatMap((segment) => Array.isArray(segment.segmentResourceGroups)
        ? segment.segmentResourceGroups
        : []).find((group: any) => groupIdOf(group) === String(groupId));
      await saveProductSegmentApi(page, {
        ...fullTripSegment,
        segmentResourceGroups: [
          ...resourceGroupDrafts(fullTripSegment.segmentResourceGroups),
          vehicleGroup(String(groupId), source),
        ],
      });
      changed = true;
    }
    // saveSegment 后平台会异步重排/回填段对象。每一轮都重新读取最新快照，
    // 只清理非首段的重复绑定；绝不拿旧对象覆盖已经收敛的段。
    latest = orderedSegments(segmentsFromPayload(await getProductSegmentsApi(page, productId)));
    for (const segment of latest) {
      if (String(segment.segmentId) === String(fullTripSegment.segmentId)) continue;
      if (!hasResourceGroup(segment, String(groupId))) continue;
      await saveProductSegmentApi(page, withoutResourceGroup(segment, String(groupId)));
      changed = true;
    }
    latest = orderedSegments(segmentsFromPayload(await getProductSegmentsApi(page, productId)));
    const target = fullTripSegmentOf(latest);
    const matched = latest.filter((segment) => hasResourceGroup(segment, String(groupId)));
    if (target && hasResourceGroup(target, String(groupId)) && matched.length === 1) {
      return {
        changed,
        resourceGroupId: groupId,
        via: "tour-helper-api",
        segmentCount: latest.length,
        targetSegmentId: String(target.segmentId),
      };
    }
  }
  const target = fullTripSegmentOf(latest);
  const matched = latest.filter((segment) => hasResourceGroup(segment, String(groupId)));
  throw new Error(`接口回读确认失败：用车资源组 ${groupId} 应仅绑定全程首段，实际绑定 ${matched.length}/${latest.length} 个行程段（首段=${String(target?.segmentId ?? "无")}；重复段=${matched.map((segment) => String(segment.segmentId)).join(",") || "无"}）`);
}

function orderedSegments(segments: Segment[]): Segment[] {
  return [...segments].sort((left, right) => Number(left.segmentBase?.segmentNumber ?? Number.MAX_SAFE_INTEGER)
    - Number(right.segmentBase?.segmentNumber ?? Number.MAX_SAFE_INTEGER));
}

/**
 * 交通子产品会在完整行程前后自动插入"多出发／多到达"边界段。用车组若绑在
 * 多出发边界，VBK 会同步到真正的首个行程段，导致 2/4 重复；因此优先首个非边界段。
 */
function fullTripSegmentOf(segments: Segment[]): Segment | undefined {
  const ordered = orderedSegments(segments);
  return ordered.find((segment) => !isTrafficBoundary(segment)) ?? ordered[0];
}

function isTrafficBoundary(segment: Segment): boolean {
  const base = segment.segmentBase ?? {};
  const departureCity = base.departureCity ?? {};
  const destinationCity = base.destinationCity ?? {};
  // 交通模块创建边界段时唯一稳定的协议标记是 cityId=0；文案 cityName 会随
  // VBK 返回 DTO 而丢失或本地化，不能只用"多出发／多到达"来判断。
  const departure = String(departureCity.cityName ?? departureCity.name ?? "").trim();
  const destination = String(destinationCity.cityName ?? destinationCity.name ?? "").trim();
  return String(departureCity.cityId ?? "") === "0"
    || String(destinationCity.cityId ?? "") === "0"
    || departure === "多出发"
    || destination === "多到达";
}

/** 页面操作未落库时，按 Tour Helper 的 saveSegment/submitSegments 协议补写并回读。 */
export async function ensureVehicleResourceBinding(
  page: any,
  productId: string,
  groupId: number,
  groupName: string,
  options: VehicleResourceBindingOptions = {},
) {
  const draft = await ensureVehicleResourceGroupDraft(page, productId, groupId, groupName);
  // 交通子产品的 submitSegments 会保留一份可读草稿；即使目标用车组已经
  // 在这份草稿中，也必须显式提交，才能取得可作为最终证据的正式资源段。
  const submitted = Boolean(draft.changed || options.submitDraft);
  if (submitted) await submitResourceSegmentsApi(page, productId);
  // After submit, draft and formal segments can coexist. Formal productSegments
  // are the only durable binding evidence for audited completion.
  const verified = submitted
    ? await waitForFormalVehicleResourceBinding(page, productId, groupId, options)
    : await verifyVehicleResourceBinding(page, productId, groupId);
  if (!verified.bound) {
    throw new Error(`接口回读确认失败：用车资源组 ${groupId} 应仅绑定全程首段，实际绑定 ${verified.matchedCount}/${verified.segmentCount} 个行程段`);
  }
  return { ...draft, audited: true };
}

/** 正式自动录入入口：严格只走接口，不根据当前页面 URL 回退 DOM。 */
export async function ensureVehicleResourceApi(page: any, product: any, productId: string) {
  if (!productNeedsVehicleResource(product)) return { skipped: "产品未配置用车资源" };
  const vehicle = product.operations?.vehicleResource;
  if (!vehicle?.resourceGroupId || !vehicle?.resourceGroupName) {
    throw new Error("产品缺少 operations.vehicleResource 资源组 ID/名称");
  }
  const groupId = Number(vehicle.resourceGroupId);
  const current: any = await getProductSegmentsApi(page, productId);
  const hasDraft = Array.isArray(current?.draftProductSegments?.segments);
  const formal = await verifyVehicleResourceBinding(page, productId, groupId, { requireFormal: true, payload: current });
  if (formal.bound && !hasDraft) {
    return {
      changed: false, resourceGroupId: groupId, audited: true,
      segmentCount: formal.segmentCount, targetSegmentId: formal.targetSegmentId,
    };
  }
  const draft = await ensureVehicleResourceGroupDraft(page, productId, groupId, String(vehicle.resourceGroupName));
  const expected = await getProductSegmentsApi(page, productId);
  const finalized = await finalizeParentResourceSegments(page, productId, expected, { vehicleGroupId: groupId });
  return { ...draft, ...finalized, resourceGroupId: groupId };
}