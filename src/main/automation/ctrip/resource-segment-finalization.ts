import { vbkSessionRequest, type VbkSessionRequestBrowser } from "../../infrastructure/vbk-session-request.js";
import { assertVbkAckSuccess } from "../../infrastructure/vbk-response-error.js";
import { getVbkInitialState } from "./traffic-line/client.js";

type Json = Record<string, any>;

const SOA = "https://online.ctrip.com/restapi/soa2/15638";
const HEAD = {
  cid: "", ctok: "", cver: "1.0", lang: "01", sid: "8888", syscode: "09", auth: "", xsid: "", extension: [],
};

export function formalResourceSegments(payload: unknown): Json[] {
  const segments = (payload as Json | undefined)?.productSegments?.segments;
  return Array.isArray(segments) ? segments : [];
}

function draftResourceSegments(payload: unknown): Json[] {
  const segments = (payload as Json | undefined)?.draftProductSegments?.segments;
  return Array.isArray(segments) ? segments : [];
}

function resourcePageUrl(productId: string): string {
  return `https://vbooking.ctrip.com/product/input/newResourceRule?productid=${encodeURIComponent(productId)}&from=vbk`;
}

async function readSegments(page: VbkSessionRequestBrowser, productId: string): Promise<Json> {
  const response = await vbkSessionRequest(page, {
    endpoint: `${SOA}/getSegments`,
    browserRequestTimeoutMs: 12_000,
    evaluateTimeoutMs: 15_000,
    errorLabel: "VBK 资源配置查询",
    headers: { cookieorigin: "https://vbooking.ctrip.com" },
    referrer: resourcePageUrl(productId),
    referrerPolicy: "no-referrer-when-downgrade",
    body: { contentType: "json", head: HEAD, productId: Number(productId) || productId },
  });
  return assertVbkAckSuccess(response.payload, "VBK 资源配置查询") as Json;
}

async function modifyUser(page: VbkSessionRequestBrowser, productId: string): Promise<string> {
  const state = await getVbkInitialState(page, resourcePageUrl(productId), "VBK 资源配置页");
  const user = (state.userInfo as Json | undefined)?.user as Json | undefined;
  const name = String(user?.name ?? "").trim();
  if (!name) throw new Error("VBK 资源配置页缺少当前会话操作账号，未发布资源模块。");
  return name;
}

async function publishSegmentModule(page: VbkSessionRequestBrowser, productId: string, user: string): Promise<void> {
  const response = await vbkSessionRequest(page, {
    endpoint: `${SOA}/publishProductModules`,
    browserRequestTimeoutMs: 15_000,
    evaluateTimeoutMs: 20_000,
    errorLabel: "VBK 资源模块发布",
    headers: { cookieorigin: "https://vbooking.ctrip.com", "x-tt-core": "1" },
    referrer: resourcePageUrl(productId),
    referrerPolicy: "no-referrer-when-downgrade",
    body: {
      contentType: "json",
      head: HEAD,
      productId: Number(productId) || productId,
      module: "segment",
      modifyUser: user,
    },
  });
  assertVbkAckSuccess(response.payload, "VBK 资源模块发布");
}

function groupIdOf(value: unknown): string {
  const group = value as Json | undefined;
  return String(group?.resourceGroupId ?? group?.resourceGroup?.resourceGroupId ?? "");
}

function ordered(segments: Json[]): Json[] {
  return [...segments].sort((left, right) => Number(left.segmentBase?.segmentNumber ?? Number.MAX_SAFE_INTEGER)
    - Number(right.segmentBase?.segmentNumber ?? Number.MAX_SAFE_INTEGER));
}

function isBoundary(segment: Json): boolean {
  const base = segment.segmentBase ?? {};
  const departure = base.departureCity ?? {};
  const destination = base.destinationCity ?? {};
  return String(departure.cityId ?? "") === "0" || String(destination.cityId ?? "") === "0"
    || String(departure.cityName ?? "").trim() === "多出发"
    || String(destination.cityName ?? "").trim() === "多到达";
}

function fullTrip(segments: Json[]): Json | undefined {
  const sorted = ordered(segments);
  return sorted.find((segment) => !isBoundary(segment)) ?? sorted[0];
}

function roomIds(segment: Json): string[] | null {
  const rooms = segment.hotel?.segmentRooms;
  if (!Array.isArray(rooms)) return [];
  const projected = rooms.map((room: Json, index: number) => ({
    id: Number(room?.masterHotelID ?? room?.hotelID),
    order: Number(room?.sequenceNumber ?? room?.sort ?? room?.sequence ?? room?.priority),
    index,
  }));
  if (projected.some(({ id }) => !Number.isSafeInteger(id) || id <= 0)) return null;
  const explicitOrder = projected.every(({ order }) => Number.isFinite(order));
  projected.sort(explicitOrder
    ? (left, right) => left.order - right.order || left.index - right.index
    : (left, right) => left.id - right.id || left.index - right.index);
  return projected.map(({ id }) => String(id));
}

function resourceGroupIds(segment: Json): string[] | null {
  const groups = segment.segmentResourceGroups;
  if (!Array.isArray(groups)) return [];
  const ids = groups.map(groupIdOf);
  if (ids.some((id) => !/^\d+$/.test(id) || Number(id) <= 0)) return null;
  return ids.sort((left, right) => Number(left) - Number(right));
}

function packageIds(segment: Json): string[] {
  const ids = new Set<string>();
  const visit = (value: unknown, parentKey = "") => {
    if (Array.isArray(value)) return value.forEach((item) => visit(item, parentKey));
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value as Json)) {
      if ((/id$/i.test(key) || /Id$/.test(key)) && /package|resource/i.test(`${parentKey}.${key}`)
        && /^\d+$/.test(String(item)) && Number(item) > 0) ids.add(String(item));
      else visit(item, `${parentKey}.${key}`);
    }
  };
  visit(segment.packages, "packages");
  return [...ids].sort();
}

function sameValues(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Compare only business-owned fields; platform remaps product/segment identity during publication. */
export function formalResourcesMatchDraft(formalInput: Json[], draftInput: Json[], groupId?: number): boolean {
  const formal = ordered(formalInput);
  const draft = ordered(draftInput);
  if (!formal.length || formal.length !== draft.length) return false;
  if (groupId !== undefined) {
    const target = fullTrip(formal);
    const matched = formal.filter((segment) => Array.isArray(segment.segmentResourceGroups)
      && segment.segmentResourceGroups.some((group: unknown) => groupIdOf(group) === String(groupId)));
    if (!target || matched.length !== 1 || matched[0] !== target) return false;
  }
  return draft.every((expected, index) => {
    const actual = formal[index]!;
    const expectedBase = expected.segmentBase ?? {};
    const actualBase = actual.segmentBase ?? {};
    const sameStay = ["stayNights", "minStayNights", "maxStayNights"].every((key) =>
      Number(actualBase[key] ?? 0) === Number(expectedBase[key] ?? 0));
    const sameCity = ["departureCity", "destinationCity"].every((key) => {
      const left = actualBase[key] ?? {};
      const right = expectedBase[key] ?? {};
      return String(left.cityId ?? "") === String(right.cityId ?? "")
        && String(left.cityName ?? "").trim() === String(right.cityName ?? "").trim();
    });
    const actualRooms = roomIds(actual);
    const expectedRooms = roomIds(expected);
    const actualGroups = resourceGroupIds(actual);
    const expectedGroups = resourceGroupIds(expected);
    return sameStay && sameCity && actualRooms !== null && expectedRooms !== null
      && actualGroups !== null && expectedGroups !== null
      && sameValues(actualRooms, expectedRooms)
      && sameValues(actualGroups, expectedGroups)
      && sameValues(packageIds(actual), packageIds(expected));
  });
}

function uncertainPublish(error: unknown): boolean {
  return /BrowserView 执行超时|浏览器请求超时|会话请求超时/.test(error instanceof Error ? error.message : String(error));
}

export async function finalizeParentResourceSegments(
  page: VbkSessionRequestBrowser,
  productId: string,
  expectedPayload: unknown,
  options: { vehicleGroupId?: number; maxReadbacks?: number; sleep?: (milliseconds: number) => Promise<void> } = {},
) {
  const expected = draftResourceSegments(expectedPayload);
  if (!expected.length) throw new Error("VBK 母产品资源发布缺少可核验草稿。");
  const before = await readSegments(page, productId);
  const currentDraft = draftResourceSegments(before);
  if (currentDraft.length && !formalResourcesMatchDraft(currentDraft, expected, options.vehicleGroupId)) {
    throw new Error("VBK 资源草稿在发布前已发生变化；未发布，请重新读取最新草稿后重试。");
  }
  if (formalResourcesMatchDraft(formalResourceSegments(before), expected, options.vehicleGroupId)) {
    return { audited: true, published: false, recovered: false, segmentCount: expected.length };
  }
  if (!currentDraft.length) throw new Error("VBK 母产品资源发布前未返回可写草稿；未发布。");
  const user = await modifyUser(page, productId);
  let timedOut = false;
  try {
    await publishSegmentModule(page, productId, user);
  } catch (error) {
    if (!uncertainPublish(error)) throw error;
    timedOut = true;
  }
  const maxReadbacks = Math.max(1, options.maxReadbacks ?? 8);
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= maxReadbacks; attempt += 1) {
    const payload = await readSegments(page, productId);
    if (formalResourcesMatchDraft(formalResourceSegments(payload), expected, options.vehicleGroupId)) {
      return { audited: true, published: true, recovered: timedOut, segmentCount: expected.length };
    }
    if (attempt < maxReadbacks) await sleep(Math.min(1_500, attempt * 300));
  }
  if (timedOut) throw new Error("VBK 资源模块发布结果不确定：正式资源回读未证明草稿已完整落库；未重复发布。");
  throw new Error("VBK 资源模块发布后正式资源回读不一致。");
}
