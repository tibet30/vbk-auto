/**
 * itinerary-api/orchestrator.ts：
 *   - 行程阶段主入口 ensureItineraryApi / ensureItinerarySpotsApi / countItineraryApiSpots；
 *   - 串起 transport / steps / stations-resolver / readback 各模块；
 *   - 不做单接口包装（那是 steps.ts 的事）；不做字段级校验（那是 readback.ts
 *     的事）；只负责"按顺序把 step 接起来 + 拼装 tourInfo payload"。
 *
 * 调用顺序：
 *   1. 接送站解析（stations-resolver）
 *   2. 拉取当前 tourInfoId（steps.fetchTourInfoId）
 *   3. 拉取详情模板（steps.fetchTourDailyDetail）用于非破坏合并
 *   3a. 读取关联的 formal/draft/audit/preview 版本；没有独立 draft 指针时
 *       fail closed，不尝试创建或升级版本
 *   4. itinerary-transform 生成 tourDailyDescriptions
 *   5. 拼装 newTourInfo payload（含 templateId / days / tourDailyDescriptions）
 *   6. checkTourDaily(saveType=2) → saveTourDailyDetail(saveType=2)
 *   7. saveProductTourInfo(saveType=2)，原样保留关联列表的版本与状态
 *   8. 只用 draftTourInfoId 做字段级回读校验
 *   9. 返回 ItineraryApiResult
 */

import {
  buildReadbackExpectations,
  type ProductItineraryDay,
  type ProductOperations,
  transformItinerary,
} from "./itinerary-transform.js";
import { verifyItineraryReadback } from "./readback.js";
import { enrichItineraryPoiMetadata } from "./poi-metadata.js";
import { resolveStationsForItinerary } from "./stations-resolver.js";
import { isExteriorOnlyVisit } from "./visit-semantics.js";
import { projectDraftWrite, type DraftWriteProjection } from "./draft-write-projection.js";
import { logInfo } from "../../../../shared/log-timestamp.js";
import {
  checkTourDailyStep,
  fetchTourDailyDetail,
  fetchTourInfoId,
  saveProductTourInfoStep,
  saveTourDailyDetailStep,
} from "./steps.js";
import type { ApiPage, ItineraryApiResult } from "./transport.js";

function linkedVersionId(tourInfo: Record<string, unknown>, field: string): string | number | undefined {
  const value = tourInfo[field];
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const id = String(value).trim();
  return /^[1-9]\d*$/.test(id) ? id : undefined;
}

function linkedVersionSummary(tourInfo: Record<string, unknown>): string {
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

function isUnsubmittedAuditStatus(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  return status.key === "N" || /未提交/.test(String(status.value ?? ""));
}

function writableTourInfoVersion(tourInfo: Record<string, unknown>): {
  id: string | number;
  field: "draftTourInfoId" | "previewTourInfoId" | "tourInfoId";
} | undefined {
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

function sameField(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function normalizedDisplay(value: string | null): string | null {
  return value?.replace(/\s+/g, " ").trim() || null;
}

function assertRetainedVersion(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  field: "tourInfoId" | "auditTourInfoId" | "previewTourInfoId" | "auditTourInfoStatus" | "auditStatus",
): void {
  if (before[field] !== undefined && !sameField(before[field], after[field])) {
    throw new Error(`VBK 草稿关联保存后 ${field} 发生未授权变化，已停止回读验收。`);
  }
}

function assertDraftWritePayload(args: {
  descriptions: unknown[];
  serialized: string;
  pickupAir?: { code: string; name: string } | null;
  exteriorBridge: boolean;
}): void {
  const generated = projectDraftWrite(args.descriptions);
  let serialized: DraftWriteProjection;
  try { serialized = projectDraftWrite(JSON.parse(args.serialized)); } catch { throw new Error("VBK 草稿写入文本序列化失败，未发送保存请求。"); }
  if (!sameField(generated, serialized)) {
    throw new Error(`VBK 草稿写入本地投影在序列化前后漂移，未发送保存请求：${JSON.stringify({ generated, serialized })}`);
  }
  if (args.pickupAir && (generated.pickup.code !== args.pickupAir.code || generated.pickup.name !== args.pickupAir.name)) {
    throw new Error(`VBK 草稿写入集合机场与已解析端点不一致，未发送保存请求：${JSON.stringify({ expected: args.pickupAir, actual: generated.pickup })}`);
  }
  if (generated.hotelGrades.some((grade) => /\/-\d+$/.test(grade.name ?? ""))) {
    throw new Error("VBK 草稿写入酒店展示等级泄露内部 tier code，未发送保存请求。");
  }
  if (generated.hotelNodes.some((node) => /\/-\d+\b/.test(node.description ?? "")
    || node.slots.some((slot) => /\/-\d+\b/.test(slot.name ?? "")))) {
    throw new Error("VBK 草稿写入酒店名称或说明泄露内部 tier code，未发送保存请求。");
  }
  if (args.exteriorBridge && (generated.bridge85862?.key !== "1" || generated.bridge85862.name !== "外观")) {
    throw new Error(`VBK 草稿写入广济桥外观票型不正确，未发送保存请求：${JSON.stringify(generated.bridge85862)}`);
  }
}

function assertCheckedDraftPayload(expected: DraftWriteProjection, checkedDraft: Record<string, unknown>): void {
  const actual = projectDraftWrite(checkedDraft);
  const pickupChanged = !sameField(expected.pickup, actual.pickup);
  const bridgeChanged = !sameField(expected.bridge85862, actual.bridge85862);
  const hotelChanged = expected.hotelNodes.length !== actual.hotelNodes.length || expected.hotelNodes.some((expectedNode, nodeIndex) => {
    const actualNode = actual.hotelNodes[nodeIndex];
    if (!actualNode || expectedNode.slots.length !== actualNode.slots.length) return true;
    if (!sameField(expectedNode.slots.map((slot) => slot.name), actualNode.slots.map((slot) => slot.name))) return true;
    return normalizedDisplay(expectedNode.description) !== normalizedDisplay(actualNode.description)
      || actualNode.slots.some((slot) => /\/-\d+\b/.test(slot.name ?? ""))
      || /\/-\d+\b/.test(actualNode.description ?? "");
  });
  if (pickupChanged || hotelChanged || bridgeChanged) {
    const airport = `集合机场实际=${actual.pickup.code ?? ""}/${actual.pickup.name ?? ""}，期望=${expected.pickup.code ?? ""}/${expected.pickup.name ?? ""}`;
    const hotels = `酒店节点实际=${actual.hotelNodes.length}/${actual.hotelNodes.map((node) => node.slots.length).join(",")}，期望=${expected.hotelNodes.length}/${expected.hotelNodes.map((node) => node.slots.length).join(",")}`;
    const bridge = `广济桥实际=${actual.bridge85862?.key ?? ""}/${actual.bridge85862?.name ?? ""}，期望=${expected.bridge85862?.key ?? ""}/${expected.bridge85862?.name ?? ""}`;
    throw new Error(`VBK 草稿校验响应改写白名单字段：${airport}；${hotels}；${bridge}；未发送详情或关联保存。`);
  }
}

export async function ensureItineraryApi(
  page: ApiPage,
  product: { itinerary: ProductItineraryDay[]; operations?: ProductOperations; productId?: string | number },
  productId: string,
): Promise<ItineraryApiResult> {
  if (!Array.isArray(product?.itinerary) || !product.itinerary.length) {
    throw new Error("行程数组为空，无法走接口保存。");
  }
  const operations: ProductOperations = product.operations ?? {};
  if (!operations.pickupCity) {
    throw new Error("operations.pickupCity 缺失，无法解析接送站。");
  }

  // 1) 接送站解析（真实接口）
  const trafficLine = (operations as Record<string, unknown>).trafficLine;
  const endpointPlan = trafficLine && typeof trafficLine === "object" && !Array.isArray(trafficLine)
    ? (trafficLine as { availability?: { endpointPlan?: unknown } }).availability?.endpointPlan
    : undefined;
  const stations = await resolveStationsForItinerary(page, { pickupCity: operations.pickupCity, endpointPlan });
  if ((!stations.pickupAir && !stations.pickupTrain) || (!stations.dropoffAir && !stations.dropoffTrain)) {
    throw new Error(`接送站搜索：城市「${operations.pickupCity}」无任何可用机场/火车站候选，或未返回完整接送站候选。`);
  }

  // 2) 按 poiId 回查真实 suggestPoi 类型，避免免费景点因 ticketType 为空被拒。
  const enrichedItinerary = await enrichItineraryPoiMetadata(page, product.itinerary);

  // 3) 关联列表是版本关系的唯一来源。没有当前 draft/preview 的产品不能
  // 凭旧 8→3 协议推断创建路径，必须停止在任何写操作之前。
  const { tourInfo, tourInfoId: existingTourInfoId, templateId } =
    await fetchTourInfoId(page, productId);
  const writableVersion = writableTourInfoVersion(tourInfo);
  const writableTourInfoId = writableVersion?.id;
  const previewTourInfoId = linkedVersionId(tourInfo, "previewTourInfoId");
  const formalTourInfoId = linkedVersionId(tourInfo, "tourInfoId");
  const auditTourInfoId = linkedVersionId(tourInfo, "auditTourInfoId");
  if (!writableTourInfoId) {
    throw new Error(`VBK 行程关联未返回独立的 draftTourInfoId 或首建未提交 previewTourInfoId；没有当前平台写入协议证据，已停止草稿保存。关联版本=${linkedVersionSummary(tourInfo)}`);
  }

  // 4) 草稿详情是正常草稿保存的输入模板；写入只以关联 draft ID 为源，绝不使用
  // formal/audit 详情替代。
  const detailId = writableTourInfoId;
  const detailTourInfo = (await fetchTourDailyDetail(page, detailId)).tourInfo;

  // 5) 用 itinerary-transform 生成完整 tourDailyDescriptions
  const tourDailyDescriptions = transformItinerary({
    itinerary: enrichedItinerary,
    operations,
    stations,
  });

  // 5) 拼装完整 tourInfo payload（含 template / templateId / days / tourDailyDescriptions）
  const newTourInfo: Record<string, unknown> = {
    ...(detailTourInfo ?? {}),
    templateId,
    productId: Number(productId) || productId,
    tourInfoId: writableTourInfoId,
    // Normal UI draft saves consistently send this flag; preserve it rather than
    // inheriting a missing value from a readonly detail template.
    isModify: true,
    days: tourDailyDescriptions.length,
    tourDailyDescriptions,
  };

  // 6) 真实 UI 证据：checkTourDaily 请求 saveType=2，productTourInfo 保持
  // formal 身份而 tourDaily 指向独立 draft/首建 preview；不调用 8/3，也不构造 score。
  const productTourInfo: Record<string, unknown> = {
    ...tourInfo,
    productId: Number(productId) || productId,
    templateId,
    days: tourDailyDescriptions.length,
  };
  const initialText = JSON.stringify(newTourInfo);
  assertDraftWritePayload({
    descriptions: tourDailyDescriptions,
    serialized: initialText,
    pickupAir: stations.pickupAir,
    exteriorBridge: enrichedItinerary.some((day) => day.spots?.some((spot) => spot.poiId === 85862 && isExteriorOnlyVisit(spot.description))),
  });
  const initialProjection = projectDraftWrite(tourDailyDescriptions);
  logInfo("[vbk-itinerary-draft] before-check", { productId, projection: initialProjection });
  const checkedDraft = await checkTourDailyStep(
    page,
    productTourInfo,
    initialText,
    2,
    "VBK 行程草稿校验(saveType=2)",
  );
  assertCheckedDraftPayload(initialProjection, checkedDraft);
  logInfo("[vbk-itinerary-draft] checked", { productId, projection: projectDraftWrite(checkedDraft) });
  // 7) 真实 UI 证据：check 响应、详情保存和关联 tourDaily 均使用独立 draft/preview ID。
  // 关联的 formal/audit/status 原样保留，不改审核指针。
  const checkedDraftId = linkedVersionId(checkedDraft, "tourInfoId");
  const checkedDraftAliases = [formalTourInfoId, auditTourInfoId].filter(Boolean);
  const allowsCheckCreatedDraft = (writableVersion.field === "previewTourInfoId" || writableVersion.field === "tourInfoId")
    && checkedDraftId
    && !checkedDraftAliases.some((id) => id === checkedDraftId);
  const effectiveWritableTourInfoId = allowsCheckCreatedDraft ? checkedDraftId : writableTourInfoId;
  if (!checkedDraftId || (!allowsCheckCreatedDraft && checkedDraftId !== writableTourInfoId)) {
    throw new Error(`VBK 行程草稿校验未回读 ${writableVersion.field}：期望=${String(writableTourInfoId)}，实际=${String(checkedDraftId ?? "")}`);
  }
  const saveDetailResult = await saveTourDailyDetailStep(page, checkedDraft, "draft-v2");
  const savedDraftId = linkedVersionId(saveDetailResult, "tourInfoId");
  if (!savedDraftId || String(savedDraftId) !== String(effectiveWritableTourInfoId)) {
    throw new Error(`VBK 行程详情草稿保存未回读 ${writableVersion.field}：期望=${String(effectiveWritableTourInfoId)}，实际=${String(savedDraftId ?? "")}`);
  }
  const associationTourInfo = allowsCheckCreatedDraft
    ? {
        ...checkedDraft,
        productId: Number(productId) || productId,
        main: tourInfo.main ?? true,
        sort: tourInfo.sort ?? 0,
        tourInfoId: effectiveWritableTourInfoId,
        auditTourInfoId: effectiveWritableTourInfoId,
        auditTourInfoStatus: 1,
        auditStatus: tourInfo.auditStatus ?? { key: "N", value: "未提交" },
      }
    : {
        ...tourInfo,
        productId: Number(productId) || productId,
        main: tourInfo.main ?? true,
        sort: tourInfo.sort ?? 0,
      };
  // saveProductTourInfo 使用带独立 draft/preview ID 的初始 tourDaily；不能把 check
  // 返回对象或 formal/audit 身份混入关联请求。
  logInfo("[vbk-itinerary-draft] before-association", { productId, projection: initialProjection });
  const associationText = allowsCheckCreatedDraft ? JSON.stringify(checkedDraft) : initialText;
  await saveProductTourInfoStep(page, associationTourInfo, associationText, "draft-v2");

  // 8) 关联写入后重新拉取版本关系。平台可以轮换可写版本 ID，但 formal/audit
  // 和审核状态必须保留；最终详情只从重新关联的独立未提交草稿版本回读。
  const { tourInfo: savedRelation } = await fetchTourInfoId(page, productId);
  const retainedFields = writableVersion.field === "draftTourInfoId"
    ? ["tourInfoId", "auditTourInfoId", "previewTourInfoId", "auditTourInfoStatus", "auditStatus"] as const
    : writableVersion.field === "previewTourInfoId" || writableVersion.field === "tourInfoId"
    ? writableVersion.field === "tourInfoId"
      ? ["auditStatus"] as const
      : ["auditTourInfoId", "auditTourInfoStatus", "auditStatus"] as const
    : ["auditStatus"] as const;
  for (const field of retainedFields) {
    assertRetainedVersion(tourInfo, savedRelation, field);
  }
  const savedDraftTourInfoId = linkedVersionId(savedRelation, "draftTourInfoId");
  const savedFormalTourInfoId = linkedVersionId(savedRelation, "tourInfoId");
  const savedAuditTourInfoId = linkedVersionId(savedRelation, "auditTourInfoId");
  const savedPreviewTourInfoId = linkedVersionId(savedRelation, "previewTourInfoId");
  const previewWritableTourInfoId = savedFormalTourInfoId ?? savedPreviewTourInfoId;
  const finalWritableTourInfoId = savedDraftTourInfoId
    ?? (writableVersion.field === "previewTourInfoId" ? previewWritableTourInfoId : undefined)
    ?? (writableVersion.field === "tourInfoId" ? savedFormalTourInfoId : undefined);
  const finalWritableField = savedDraftTourInfoId
    ? "draftTourInfoId"
    : savedFormalTourInfoId && writableVersion.field === "previewTourInfoId"
      ? "tourInfoId"
      : writableVersion.field;
  const finalAliases = finalWritableField === "draftTourInfoId"
    ? [savedFormalTourInfoId, savedAuditTourInfoId, savedPreviewTourInfoId].filter(Boolean)
    : finalWritableField === "previewTourInfoId"
      ? [savedFormalTourInfoId, savedAuditTourInfoId].filter(Boolean)
      : [];
  const finalStatusOk = finalWritableField === "draftTourInfoId"
    ? savedRelation.draftTourInfoStatus === 1 || savedRelation.draftTourInfoStatus === "1"
    : isUnsubmittedAuditStatus(savedRelation.auditStatus)
      && (!savedAuditTourInfoId || savedAuditTourInfoId === finalWritableTourInfoId);
  if (!finalWritableTourInfoId || !finalStatusOk || finalAliases.some((id) => id === finalWritableTourInfoId)) {
    throw new Error(`VBK 草稿关联保存后未返回独立的未提交 ${finalWritableField}，已停止回读验收。关联版本=${linkedVersionSummary(savedRelation)}`);
  }

  // 9) 完整回读校验（字段级逐天比对）
  const readbackExpectations = buildReadbackExpectations({
    itinerary: enrichedItinerary,
    operations,
    stations,
  });
  const verify = await verifyItineraryReadback(page, finalWritableTourInfoId, readbackExpectations);

  // 10) 业务结果
  return {
    productId,
    tourInfoId: finalWritableTourInfoId,
    auditTourInfoId: savedAuditTourInfoId ?? auditTourInfoId ?? "",
    days: verify.days,
    savedSpots: verify.spots,
    savedMeals: verify.meals,
    savedHotels: verify.hotels,
    pickupAirport: stations.pickupAir?.code ?? "",
    pickupTrain: stations.pickupTrain?.code ?? "",
    dropoffAirport: stations.dropoffAir?.code ?? "",
    dropoffTrain: stations.dropoffTrain?.code ?? "",
  };
}

/** 兼容旧入口：保留 spots-only API 入口供 itinerary/main.ts 接入。 */
export async function ensureItinerarySpotsApi(
  page: ApiPage,
  product: { itinerary?: ProductItineraryDay[]; operations?: ProductOperations; productId?: string | number },
  productId: string,
) {
  if (!product.itinerary) throw new Error("行程数组为空。");
  return ensureItineraryApi(page, product as { itinerary: ProductItineraryDay[]; operations?: ProductOperations; productId?: string | number }, productId);
}

/** 兼容旧单元测试：只统计景点 POI 数量。 */
export function countItineraryApiSpots(detail: {
  tourInfo?: {
    tourDailyDescriptions?: Array<{
      tourDailyInfos?: Array<{ activeType?: { key?: number; name?: string }; tourDailyPois?: unknown[] }>;
    }>;
  };
}): number {
  const days = detail?.tourInfo?.tourDailyDescriptions ?? [];
  return days.reduce(
    (total: number, day: { tourDailyInfos?: Array<{ activeType?: { key?: number; name?: string }; tourDailyPois?: unknown[] }> }) => {
      const infos = Array.isArray(day.tourDailyInfos) ? day.tourDailyInfos : [];
      return total + infos
        .filter((info) => info?.activeType?.key === 3 || info?.activeType?.name === "景点")
        .reduce(
          (dayTotal: number, info: { tourDailyPois?: unknown[] }) =>
            dayTotal + (Array.isArray(info.tourDailyPois) ? info.tourDailyPois.length : 0),
          0,
        );
    },
    0,
  );
}
