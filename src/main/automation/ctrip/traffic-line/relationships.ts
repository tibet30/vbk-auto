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
): Promise<TrafficLineExistingChild> {
  const before = await readTrafficLineChildren(page, parentProductId);
  const matches = matchingChildren(before, target.variant);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`母产品下存在 ${matches.length} 个「${target.lineDescription}」子产品，无法安全继续。`);

  const template = await getTrafficLineCreateTemplate(page, parentProductId);
  const saved = await saveTrafficLineChild(page, buildTrafficLineSaveRequest(parentProductId, target, template));
  const after = await readTrafficLineChildren(page, parentProductId);
  const verified = matchingChildren(after, target.variant);
  if (verified.length !== 1 || verified[0]?.productId !== saved.productId) {
    throw new Error(`创建${target.lineDescription}子产品后母子关系回读不一致。`);
  }
  return verified[0];
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
