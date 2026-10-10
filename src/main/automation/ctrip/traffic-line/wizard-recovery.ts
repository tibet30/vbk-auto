import { getProductBaseInfoApi } from "../basic-info/read-base.js";
import { postTrafficLineSoa, type TrafficLinePage } from "./client.js";

/** 按官方“下一步”推进初建向导，原样保存远端内容；不会发布或启用套餐。 */
export async function advanceSavedProductWizard(
  page: TrafficLinePage,
  productId: string,
  options: { authorization: "submit-route-review"; recommendationCategoryOverrides?: Record<number, number> },
) {
  if (options.authorization !== "submit-route-review") throw new Error("尚未授权线路审核恢复。");
  let remote = await getProductBaseInfoApi(page, productId);
  if (Number(remote.meta?.saveStep) < -70) {
    const booking = remote.bookingControls ?? remote.bookingControl;
    if (!booking || !remote.baseInfo || !Array.isArray(remote.nameAreas)) throw new Error("基本信息保存模型不完整，向导未推进。");
    await postTrafficLineSoa(page, "15638", "saveProductBaseInfo", {
      baseInfo: remote.baseInfo, bookingControl: { ...booking, personQuantity: {
        minPersonQuantity: booking.minPersonQuantity, maxPersonQuantity: booking.maxPersonQuantity,
      } }, nameAreaRules: remote.nameAreas,
      meta: { ...remote.meta, saveType: 2, resizeTourDailyInfo: "F", clauseTabEnabled: "F" },
      advancedSettings: remote.advancedSettings, scenicSpots: remote.scenicSpots ?? [],
      resourceFields: remote.resourceFields ?? {},
    }, "推进已保存基本信息向导");
    remote = await getProductBaseInfoApi(page, productId);
    if (Number(remote.meta?.saveStep) < -70) throw new Error("基本信息向导推进后回读未确认。");
  }
  if (Number(remote.meta?.saveStep) < -60) {
    const current = await postTrafficLineSoa(page, "15638", "getdescriptionInfo", { productId: Number(productId) }, "回读已保存图文");
    const info = current.info as Record<string, any> | undefined;
    if (!info?.productDesc || !Array.isArray(info.pmRcmdItems)) throw new Error("图文保存模型不完整，向导未推进。");
    const items = info.pmRcmdItems.map((item: Record<string, any>) => ({ ...item,
      pmRcmdCategoryId: options.recommendationCategoryOverrides?.[item.pmRcmdCategoryId] ?? item.pmRcmdCategoryId,
    }));
    await postTrafficLineSoa(page, "20698", "createProductDraft", { productId: Number(productId), module: "desc" }, "创建图文恢复草稿");
    await postTrafficLineSoa(page, "15638", "savedescriptioninfo", { dto: {
      ...info, productId: Number(productId), saveType: 4, pmRcmdItems: items,
    } }, "推进已保存图文向导");
    remote = await getProductBaseInfoApi(page, productId);
    if (Number(remote.meta?.saveStep) < -60) throw new Error("图文向导推进后回读未确认。");
  }
  return { productId, saveStep: Number(remote.meta?.saveStep) };
}
