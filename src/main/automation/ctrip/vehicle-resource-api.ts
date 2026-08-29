import { vbkSessionRequest } from "../../infrastructure/vbk-session-request.js";

type Segment = Record<string, any>;

const head = {
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

export async function getProductSegmentsApi(page: any, productId: string) {
  const response = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/getSegments",
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    errorLabel: "VBK 资源配置查询",
    body: { contentType: "json", head, productId: Number(productId) || productId },
  });
  return response.payload;
}

function assertResponse(payload: any, label: string) {
  const status = payload?.ResponseStatus;
  if (status?.Ack === "Failure" || (Array.isArray(status?.Errors) && status.Errors.length)) {
    throw new Error(`${label}失败：${JSON.stringify(status.Errors ?? status).slice(0, 400)}`);
  }
}

async function saveSegment(page: any, segment: Segment) {
  const response = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/saveSegment",
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    errorLabel: "VBK 用车资源组保存",
    body: { contentType: "json", head, segment },
  });
  assertResponse(response.payload, "VBK 用车资源组保存");
}

async function submitSegments(page: any, productId: string) {
  const response = await vbkSessionRequest(page, {
    endpoint: "https://online.ctrip.com/restapi/soa2/15638/submitSegments",
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    errorLabel: "VBK 资源配置提交",
    body: {
      contentType: "json",
      head,
      productId: Number(productId) || productId,
      // Tour Helper 的 submitSegments 协议要求 schedule 为日期数组，而不是周排期字符串。
      schedule: futureSchedule(),
      adultCount: 2,
      childCount: 0,
      audit: { saveStep: 2 },
    },
  });
  assertResponse(response.payload, "VBK 资源配置提交");
}

function futureSchedule() {
  const today = new Date();
  return [1, 8, 15].map((offset) => {
    const date = new Date(today);
    date.setDate(date.getDate() + 90 + offset);
    return date.toISOString().slice(0, 10);
  });
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

/** 读取 Tour Helper 使用的后端数据，确认每个行程段是否已绑定目标用车组。 */
export async function verifyVehicleResourceBinding(page: any, productId: string, groupId: number) {
  const payload = await getProductSegmentsApi(page, productId);
  const all = segmentsFromPayload(payload);
  const matched = matchingSegments(payload, String(groupId));
  return { bound: all.length > 0 && matched.length === all.length, segmentCount: all.length, matchedCount: matched.length };
}

/** 页面操作未落库时，按 Tour Helper 的 saveSegment/submitSegments 协议补写并回读。 */
export async function ensureVehicleResourceBinding(page: any, productId: string, groupId: number, groupName: string) {
  const before: any = await getProductSegmentsApi(page, productId);
  if (!before?.draftProductSegments?.segments) {
    const maintain = await vbkSessionRequest(page, {
      endpoint: "https://online.ctrip.com/restapi/soa2/15638/saveProductMaintainType",
      browserRequestTimeoutMs: 12_000,
      evaluateTimeoutMs: 15_000,
      errorLabel: "VBK 资源配置维护类型初始化",
      body: { contentType: "json", head, productId: Number(productId) || productId, maintainType: "P" },
    });
    assertResponse(maintain.payload, "VBK 资源配置维护类型初始化");
    const draft = await vbkSessionRequest(page, {
      endpoint: "https://online.ctrip.com/restapi/soa2/15638/createProductDraft",
      browserRequestTimeoutMs: 12_000,
      evaluateTimeoutMs: 15_000,
      errorLabel: "VBK 资源配置草稿初始化",
      body: { contentType: "json", head, module: "segment", productId: Number(productId) || productId },
    });
    assertResponse(draft.payload, "VBK 资源配置草稿初始化");
  }
  const current: any = before?.draftProductSegments?.segments ? before : await getProductSegmentsApi(page, productId);
  const segments = segmentsFromPayload(current);
  if (!segments.length) throw new Error("VBK 资源配置未返回任何行程段");
  const missing = segments.filter((segment) => !Array.isArray(segment.segmentResourceGroups)
    || !segment.segmentResourceGroups.some((group: any) => groupIdOf(group) === String(groupId)));
  for (const segment of missing) {
    await saveSegment(page, {
      ...segment,
      segmentResourceGroups: [
        ...(Array.isArray(segment.segmentResourceGroups) ? segment.segmentResourceGroups : []),
        vehicleGroup(String(groupId), groupName, segment.segmentId),
      ],
    });
  }
  if (missing.length) await submitSegments(page, productId);
  const after = await getProductSegmentsApi(page, productId);
  const afterSegments = segmentsFromPayload(after);
  const matchedAfter = matchingSegments(after, String(groupId));
  if (!afterSegments.length || matchedAfter.length !== afterSegments.length) {
    throw new Error(`接口回读确认失败：用车资源组 ${groupId} 仅绑定 ${matchedAfter.length}/${afterSegments.length} 个行程段`);
  }
  return { resourceGroupId: groupId, audited: true, via: "tour-helper-api", segmentCount: afterSegments.length };
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
