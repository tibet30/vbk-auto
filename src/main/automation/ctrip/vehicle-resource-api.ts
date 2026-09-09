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

export function segmentsFromPayload(payload: any, options: { formalOnly?: boolean } = {}): Segment[] {
  if (options.formalOnly) return payload?.productSegments?.segments ?? [];
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

function resourceGroupDrafts(groups: unknown): Segment["segmentResourceGroups"] {
  if (!Array.isArray(groups)) return [];
  return groups
    .filter((group) => Number.isInteger(Number(groupIdOf(group))) && Number(groupIdOf(group)) > 0)
    // VBK 资源编辑器只提交资源组 ID、排序和供应商 ID。回传的完整资源组
    // DTO 会让 saveSegment 把旧关联合并回来，特别是在交通子产品的草稿上。
    .map((group, sort) => ({
      resourceGroupId: Number(groupIdOf(group)),
      sort,
      resourceGroup: { vendorId: group?.resourceGroup?.vendorId ?? null },
    }));
}

function withoutResourceGroup(segment: Segment, groupId: string): Segment {
  return {
    ...segment,
    segmentResourceGroups: resourceGroupDrafts((Array.isArray(segment.segmentResourceGroups)
      ? segment.segmentResourceGroups
      : []).filter((group: any) => groupIdOf(group) !== groupId)),
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
  return initializeResourceSegmentsDraftApi(page, productId);
}

/**
 * 资源服务偶尔会返回过期的 draftProductSegments 外壳，但 saveSegment 随后明确
 * 拒绝并报“产品还没有创建草稿”。调用方已经读回确认没有任何段内写入时，才可
 * 走这个受控的初始化和一次重试；不能把它用于不确定的部分保存恢复。
 */
export async function initializeResourceSegmentsDraftApi(page: any, productId: string) {
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
  options: { requireFormal?: boolean } = {},
) {
  const payload = await getProductSegmentsApi(page, productId);
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

type VehicleResourceBindingOptions = {
  submitDraft?: boolean;
  formalReadbackAttempts?: number;
  formalReadbackIntervalMs?: number;
};

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
  const attempts = Math.max(1, options.formalReadbackAttempts ?? 8);
  const intervalMs = Math.max(0, options.formalReadbackIntervalMs ?? 750);
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
 * 结算草稿，因此不能先单独 submitSegments，否则会抢先触发“缺少交通段”校验。
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
 * 交通子产品会在完整行程前后自动插入「多出发／多到达」边界段。用车组若绑在
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
  // VBK 返回 DTO 而丢失或本地化，不能只用“多出发／多到达”来判断。
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
  if (product.sales?.productForm !== "privateTour") return { skipped: "非私家团" };
  const vehicle = product.operations?.vehicleResource;
  if (!vehicle?.resourceGroupId || !vehicle?.resourceGroupName) {
    throw new Error("私家团缺少 operations.vehicleResource 资源组 ID/名称");
  }
  return ensureVehicleResourceBinding(page, productId, Number(vehicle.resourceGroupId), String(vehicle.resourceGroupName));
}
