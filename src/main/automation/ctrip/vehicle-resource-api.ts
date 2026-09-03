import { vbkSessionRequest } from "../../infrastructure/vbk-session-request.js";

type Segment = Record<string, any>;
type ResourceCity = Record<string, any>;

export const VBK_RESOURCE_HEAD = {
  cid: "",
  ctok: "",
  cver: "1.0",
  lang: "01",
  sid: "8888",
  syscode: "09",
  auth: "",
  xsid: "",
  extension: [],
};

export function segmentsFromPayload(payload: any): Segment[] {
  return payload?.draftProductSegments?.segments
    ?? payload?.productSegments?.segments
    ?? [];
}

function groupIdOf(value: any): string {
  return String(value?.resourceGroupId ?? value?.resourceGroup?.resourceGroupId ?? "");
}

function matchingSegments(payload: any, groupId: string): Segment[] {
  return segmentsFromPayload(payload).filter((segment) =>
    Array.isArray(segment.segmentResourceGroups)
    && segment.segmentResourceGroups.some((group: any) => groupIdOf(group) === groupId),
  );
}

function hasResourceGroup(segment: Segment, groupId: string) {
  return Array.isArray(segment.segmentResourceGroups)
    && segment.segmentResourceGroups.some((group: any) => groupIdOf(group) === groupId);
}

function withoutResourceGroup(segment: Segment, groupId: string): Segment {
  return {
    ...segment,
    segmentResourceGroups: (Array.isArray(segment.segmentResourceGroups)
      ? segment.segmentResourceGroups
      : []).filter((group: any) => groupIdOf(group) !== groupId),
  };
}

export async function getProductSegmentsApi(page: any, productId: string) {
  const response = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/getSegments",
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    errorLabel: "VBK 资源配置查询",
    body: { contentType: "json", head: VBK_RESOURCE_HEAD, productId: Number(productId) || productId },
  });
  return response.payload;
}

export function assertVbkResourceResponse(payload: any, label: string) {
  const status = payload?.ResponseStatus;
  if (status?.Ack === "Failure" || (Array.isArray(status?.Errors) && status.Errors.length)) {
    throw new Error(`${label}失败：${JSON.stringify(status.Errors ?? status).slice(0, 400)}`);
  }
}

/** 按资源编辑器的 /15638/saveSegment 协议保存完整行程段。 */
export async function saveProductSegmentApi(page: any, segment: Segment, errorLabel = "VBK 资源行程段保存") {
  const response = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/saveSegment",
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    errorLabel,
    body: { contentType: "json", head: VBK_RESOURCE_HEAD, segment },
  });
  assertVbkResourceResponse(response.payload, errorLabel);
}

/**
 * 资源编辑器的城市选择框同样使用 suggestDepartureCity。只接受唯一的精确城市，
 * 防止同名地级市或区县被误写到住宿行程段。
 */
export async function resolveResourceSegmentCityApi(page: any, cityName: string): Promise<ResourceCity> {
  const expected = cityName.trim();
  if (!expected) throw new Error("住宿资源行程段缺少城市名称");
  const response = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/suggestDepartureCity",
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    errorLabel: "VBK 住宿城市查询",
    headers: { cookieorigin: "https://vbooking.ctrip.com" },
    body: { contentType: "json", head: VBK_RESOURCE_HEAD, keyword: expected },
  });
  assertVbkResourceResponse(response.payload, "VBK 住宿城市查询");
  const cities = Array.isArray((response.payload as any)?.cities)
    ? (response.payload as any).cities
    : [];
  const matches = cities.filter((city: any) => String(city?.cityName ?? "").trim() === expected);
  if (matches.length !== 1 || Number(matches[0]?.cityId) <= 0) {
    throw new Error(`住宿城市「${expected}」无法唯一匹配：${matches.length} 个精确候选`);
  }
  return structuredClone(matches[0]);
}

/**
 * 以平台末尾空段为模板，在其前插入一个住宿段。新段绝不继承套餐、用车或酒店，
 * 并把停留范围与住宿晚数锁为同一个值，满足资源配置页的单值行程段语义。
 */
export function buildLodgingResourceSegment(args: {
  terminalTemplate: Segment;
  segmentNumber: number;
  departureCity: ResourceCity;
  destinationCity: ResourceCity;
  nights: number;
}): Segment {
  const nights = Number(args.nights);
  if (!Number.isInteger(nights) || nights <= 0) throw new Error(`住宿晚数无效：${String(args.nights)}`);
  const draft = structuredClone(args.terminalTemplate);
  return {
    ...draft,
    // saveSegment 的服务端会直接解包并读取 segmentId。新段必须明确传 0，
    // 空值会在服务端 Long.longValue() 处抛出空指针，无法触发新增逻辑。
    segmentId: 0,
    segmentResourceGroups: [],
    hotel: { segmentRooms: [] },
    segmentBase: {
      ...(draft.segmentBase ?? {}),
      segmentNumber: Number(args.segmentNumber),
      departureCity: structuredClone(args.departureCity),
      destinationCity: structuredClone(args.destinationCity),
      stayNights: nights,
      minStayNights: nights,
      maxStayNights: nights,
      deleteable: true,
    },
  };
}

/**
 * 提交资源配置草稿，使 saveSegment 的段内变更成为可跨页面保留的资源配置。
 * 这不是产品“提交审核”；审核仍只能由用户在 VBK 产品页手动发起。
 */
export async function submitResourceSegmentsApi(page: any, productId: string) {
  const response = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/submitSegments",
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    errorLabel: "VBK 资源配置提交",
    body: {
      contentType: "json",
      head: VBK_RESOURCE_HEAD,
      productId: Number(productId) || productId,
      // Tour Helper 的 submitSegments 协议要求 schedule 为日期数组，而不是周排期字符串。
      schedule: futureSchedule(),
      adultCount: 2,
      childCount: 0,
      audit: { saveStep: 2 },
    },
  });
  assertVbkResourceResponse(response.payload, "VBK 资源配置提交");
}

function futureSchedule() {
  const today = new Date();
  return [1, 8, 15].map((offset) => {
    const date = new Date(today);
    date.setDate(date.getDate() + 90 + offset);
    return date.toISOString().slice(0, 10);
  });
}

/**
 * 新建产品的 getSegments 可能只返回线上段，而没有可写的 draftProductSegments。
 * 酒店阶段先于用车阶段执行，故草稿初始化必须作为两者共享的前置条件，而不能
 * 依赖用车阶段碰巧先运行。
 */
export async function ensureResourceSegmentsDraftApi(page: any, productId: string) {
  const before: any = await getProductSegmentsApi(page, productId);
  if (Array.isArray(before?.draftProductSegments?.segments)) return before;
  const maintain = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/saveProductMaintainType",
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    errorLabel: "VBK 资源配置维护类型初始化",
    body: { contentType: "json", head: VBK_RESOURCE_HEAD, productId: Number(productId) || productId, maintainType: "P" },
  });
  assertVbkResourceResponse(maintain.payload, "VBK 资源配置维护类型初始化");
  const draft = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/createProductDraft",
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    errorLabel: "VBK 资源配置草稿初始化",
    body: { contentType: "json", head: VBK_RESOURCE_HEAD, module: "segment", productId: Number(productId) || productId },
  });
  assertVbkResourceResponse(draft.payload, "VBK 资源配置草稿初始化");
  const current: any = await getProductSegmentsApi(page, productId);
  if (!Array.isArray(current?.draftProductSegments?.segments)) {
    throw new Error("VBK 资源配置草稿初始化后仍未返回可写行程段");
  }
  return current;
}

function vehicleGroup(groupId: string, groupName: string, segmentId: unknown) {
  return {
    segmentId,
    resourceGroupId: Number(groupId),
    sort: 0,
    resourceGroup: {
      resourceGroupId: Number(groupId),
      resourceGroupName: groupName,
      resourcePICategoryId: 1132,
      resourcePICategoryName: "用车",
      active: "T",
      maxSelectCount: 1,
      minSelectCount: 1,
      maxItemCount: 20,
      mandatory: "T",
      locale: "zh-CN",
      description: "",
    },
    resources: [],
  };
}

/** 读取 Tour Helper 使用的后端数据，确认仅全程首段绑定目标用车组。 */
export async function verifyVehicleResourceBinding(page: any, productId: string, groupId: number) {
  const payload = await getProductSegmentsApi(page, productId);
  const all = segmentsFromPayload(payload);
  const matched = matchingSegments(payload, String(groupId));
  const first = all[0];
  return {
    bound: Boolean(first) && hasResourceGroup(first, String(groupId)) && matched.length === 1,
    segmentCount: all.length,
    matchedCount: matched.length,
    targetSegmentId: first ? String(first.segmentId) : undefined,
  };
}

/** 页面操作未落库时，按 Tour Helper 的 saveSegment/submitSegments 协议补写并回读。 */
export async function ensureVehicleResourceBinding(page: any, productId: string, groupId: number, groupName: string) {
  const current: any = await ensureResourceSegmentsDraftApi(page, productId);
  const segments = segmentsFromPayload(current);
  if (!segments.length) throw new Error("VBK 资源配置未返回任何行程段");
  const [fullTripSegment, ...lodgingOrTerminalSegments] = segments;
  if (!fullTripSegment) throw new Error("VBK 资源配置未返回全程行程段");
  const targetMissing = !hasResourceGroup(fullTripSegment, String(groupId));
  const surplus = lodgingOrTerminalSegments.filter((segment) => hasResourceGroup(segment, String(groupId)));
  if (targetMissing) {
    await saveProductSegmentApi(page, {
      ...fullTripSegment,
      segmentResourceGroups: [
        ...(Array.isArray(fullTripSegment.segmentResourceGroups) ? fullTripSegment.segmentResourceGroups : []),
        vehicleGroup(String(groupId), groupName, fullTripSegment.segmentId),
      ],
    });
  }
  for (const segment of surplus) {
    await saveProductSegmentApi(page, withoutResourceGroup(segment, String(groupId)));
  }
  if (targetMissing || surplus.length) await submitResourceSegmentsApi(page, productId);
  const after = await getProductSegmentsApi(page, productId);
  const afterSegments = segmentsFromPayload(after);
  const matchedAfter = matchingSegments(after, String(groupId));
  const targetAfter = afterSegments[0];
  if (!targetAfter || !hasResourceGroup(targetAfter, String(groupId)) || matchedAfter.length !== 1) {
    throw new Error(`接口回读确认失败：用车资源组 ${groupId} 应仅绑定全程首段，实际绑定 ${matchedAfter.length}/${afterSegments.length} 个行程段`);
  }
  return {
    resourceGroupId: groupId,
    audited: true,
    via: "tour-helper-api",
    segmentCount: afterSegments.length,
    targetSegmentId: String(targetAfter.segmentId),
  };
}

/** 正式自动录入入口：严格只走接口，不根据当前页面 URL 回退 DOM。 */
export async function ensureVehicleResourceApi(page: any, product: any, productId: string) {
  if (product.sales?.productForm !== "privateTour") return { skipped: "非私家团" };
  const vehicle = product.operations?.vehicleResource;
  if (!vehicle?.resourceGroupId || !vehicle?.resourceGroupName) {
    throw new Error("私家团缺少 operations.vehicleResource 资源组 ID/名称");
  }
  return ensureVehicleResourceBinding(page, productId, Number(vehicle.resourceGroupId), String(vehicle.resourceGroupName));
}
