/**
 * itinerary-api/draft-write-guards.ts：草稿写入前后的白名单投影守卫。
 *   - assertDraftWritePayload：本地生成的 tourDaily 在序列化前后不得漂移，
 *     集合机场、酒店展示等级与广济桥外观票型必须与已解析期望一致；
 *   - assertCheckedDraftPayload：check(2) 响应不得改写上述白名单字段，
 *     否则在发出详情或关联保存前 fail closed。
 *
 * 只做投影比对，不接触网络与持久化；由 orchestrator 在写请求前后调用。
 */

import { projectDraftWrite, type DraftWriteProjection } from "./draft-write-projection.js";
import { sameField } from "./versioning.js";

function normalizedDisplay(value: string | null): string | null {
  return value?.replace(/\s+/g, " ").trim() || null;
}

export function assertDraftWritePayload(args: {
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

export function assertCheckedDraftPayload(expected: DraftWriteProjection, checkedDraft: Record<string, unknown>): void {
  const actual = projectDraftWrite(checkedDraft);
  const pickupChanged = !sameField(expected.pickup, actual.pickup);
  const bridgeChanged = !sameField(expected.bridge85862, actual.bridge85862);
  const transportChanged = !sameField(expected.transportNodes, actual.transportNodes);
  const hotelChanged = expected.hotelNodes.length !== actual.hotelNodes.length || expected.hotelNodes.some((expectedNode, nodeIndex) => {
    const actualNode = actual.hotelNodes[nodeIndex];
    if (!actualNode || expectedNode.slots.length !== actualNode.slots.length) return true;
    if (!sameField(expectedNode.slots.map((slot) => slot.name), actualNode.slots.map((slot) => slot.name))) return true;
    return normalizedDisplay(expectedNode.description) !== normalizedDisplay(actualNode.description)
      || actualNode.slots.some((slot) => /\/-\d+\b/.test(slot.name ?? ""))
      || /\/-\d+\b/.test(actualNode.description ?? "");
  });
  if (pickupChanged || hotelChanged || bridgeChanged || transportChanged) {
    const airport = `集合机场实际=${actual.pickup.code ?? ""}/${actual.pickup.name ?? ""}，期望=${expected.pickup.code ?? ""}/${expected.pickup.name ?? ""}`;
    const hotels = `酒店节点实际=${actual.hotelNodes.length}/${actual.hotelNodes.map((node) => node.slots.length).join(",")}，期望=${expected.hotelNodes.length}/${expected.hotelNodes.map((node) => node.slots.length).join(",")}`;
    const bridge = `广济桥实际=${actual.bridge85862?.key ?? ""}/${actual.bridge85862?.name ?? ""}，期望=${expected.bridge85862?.key ?? ""}/${expected.bridge85862?.name ?? ""}`;
    throw new Error(`VBK 草稿校验响应改写白名单字段：${airport}；${hotels}；${bridge}；交通卡片${transportChanged ? "被改写或丢失" : "一致"}；未发送详情或关联保存。`);
  }
}
