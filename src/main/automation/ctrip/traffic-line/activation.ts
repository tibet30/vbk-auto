import { postTrafficLineSoa, type TrafficLinePage } from "./client.js";
import { readTrafficLineChildren } from "./relationships.js";
import type { TrafficLineExistingChild } from "./types.js";

/** 套餐有效化仅在此前所有子步骤成功后调用；不会提交审核或发布产品。 */
export async function ensureTrafficLinePackageActive(
  page: TrafficLinePage,
  parentProductId: string,
  child: TrafficLineExistingChild,
): Promise<TrafficLineExistingChild> {
  if (!child.packageId) throw new Error(`子产品「${child.lineDescription}」缺少 packageId，不能尝试设为有效。`);
  if (child.active === true) return child;
  await postTrafficLineSoa(page, "15638", "updatePackageStatus", {
    packageId: child.packageId,
    packageType: "specialPackage",
  }, `设置${child.lineDescription}子产品套餐有效`);
  const readback = await readTrafficLineChildren(page, parentProductId);
  const verified = readback.filter((candidate) => candidate.productId === child.productId && candidate.packageId === child.packageId);
  if (verified.length !== 1 || verified[0]?.active !== true) {
    throw new Error(`设置${child.lineDescription}子产品套餐有效后回读未确认有效状态。`);
  }
  return verified[0];
}
