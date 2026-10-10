import { normaliseTrafficLineVariant, type TrafficLineVariant } from "../../../../shared/contracts-traffic-line.js";
import { getTrafficLineEditorState, list, positiveId, record, text, type TrafficLinePage } from "./client.js";
import { getTrafficLineCreateTemplate, saveTrafficLineChild } from "./api.js";
import { buildTrafficLineSaveRequest } from "./orchestrator.js";
import type { TrafficLineExistingChild, TrafficLineTarget } from "./types.js";

export async function readTrafficLineChildren(
  page: TrafficLinePage,
  parentProductId: string,
): Promise<TrafficLineExistingChild[]> {
  const state = await getTrafficLineEditorState(page, parentProductId);
  const childList = findChildList(state);
  if (!childList) throw new Error("线路及交通编辑页缺少 childList，无法确认母子产品关系。");
  return childList.flatMap((item) => {
    const productId = positiveId(item.subProductId) || positiveId(item.productId);
    const lineDescription = text(item.lineDescription);
    if (!productId || !lineDescription) return [];
    const packageId = positiveId(item.packageId);
    const active = isTrafficLineChildActive(item);
    return [{ productId, lineDescription, ...(packageId ? { packageId } : {}), ...(active === undefined ? {} : { active }) }];
  });
}

export async function ensureTrafficLineRelationship(
  page: TrafficLinePage,
  parentProductId: string,
  target: TrafficLineTarget,
  options: { expectedChildId?: string; onCreated?: (productId: string) => void;
    maxReadbacks?: number; sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<TrafficLineExistingChild> {
  const before = await readTrafficLineChildren(page, parentProductId);
  const matches = matchingChildren(before, target.variant);
  if (matches.length === 1) {
    if (options.expectedChildId && matches[0]!.productId !== options.expectedChildId) {
      throw new Error(`已保存子产品 ${options.expectedChildId} 与当前母子关系不一致，停止创建。`);
    }
    return matches[0]!;
  }
  if (matches.length > 1) throw new Error(`母产品下存在 ${matches.length} 个「${target.lineDescription}」子产品，无法安全继续。`);

  let childId = options.expectedChildId;
  if (!childId) {
    const template = await getTrafficLineCreateTemplate(page, parentProductId);
    const saved = await saveTrafficLineChild(page, buildTrafficLineSaveRequest(parentProductId, target, template));
    childId = saved.productId;
    options.onCreated?.(childId);
  }
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  const attempts = Math.max(1, options.maxReadbacks ?? 30);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const verified = matchingChildren(await readTrafficLineChildren(page, parentProductId), target.variant);
    if (verified.length === 1 && verified[0]!.productId === childId) return verified[0]!;
    if (verified.length) throw new Error(`创建${target.lineDescription}子产品 ${childId} 后母子关系回读不一致，停止重复创建。`);
    if (attempt < attempts) await sleep(1000);
  }
  throw new Error(`创建${target.lineDescription}子产品 ${childId} 后母子关系仍未完成，保留已创建记录，停止重复创建。`);
}

export function matchingChildren(
  children: readonly TrafficLineExistingChild[],
  variant: TrafficLineVariant,
): TrafficLineExistingChild[] {
  return children.filter((child) => normaliseTrafficLineVariant(child.lineDescription) === variant);
}

function findChildList(state: Record<string, unknown>): ReturnType<typeof list> | null {
  const direct = list(state.childList);
  if (direct.length || Array.isArray(state.childList)) return direct;
  for (const key of ["packageInfo", "data", "trafficLineInfo", "trafficLineEdit"] as const) {
    const nested = record(state[key]);
    if (!nested) continue;
    const entries = list(nested.childList);
    if (entries.length || Array.isArray(nested.childList)) return entries;
  }
  return null;
}

export function isTrafficLineChildActive(item: Record<string, unknown>): boolean | undefined {
  const value = item.isActiveInPackage ?? item.isActiveInProduct
    ?? item.active ?? item.isActive ?? item.packageStatus ?? item.status;
  if (value === true || value === "T" || value === "valid" || value === "VALID") return true;
  if (value === false || value === "F" || value === "invalid" || value === "INVALID") return false;
  return undefined;
}
