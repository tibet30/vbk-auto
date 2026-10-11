import { ensureBasicInfoApi, isProductLineResolutionError } from "../../ctrip/basic-info/api.js";
import { shouldRefillBasicInfo } from "../../schema/schema.js";
import { writeAutomationProduct } from "../automation.main.persist.js";
import { refreshSupplierProductCodeForPlatformWrite } from "../automation.main.class.helpers.js";
import type { AutomationRunContext } from "../automation.main.context.js";
import type { AutomationSetup } from "../automation.main.run/setup.js";
import { executeDraftPhase } from "./phase.js";

export type BasicExecutionState = Pick<AutomationSetup,
  "productDetail" | "product" | "run" | "page" | "log" | "persist" | "butlerSelection"
  | "servicePhone" | "scenicSpotLogs" | "basicInfoSaved" | "productLineBlocked">;

/** Basic info shares supplier-code refresh, account context and remote verification in both modes. */
export function buildBasicExecute(
  ctx: AutomationRunContext,
  setup: BasicExecutionState,
  productIdRef: { current: string | undefined },
) {
  return async () => executeDraftPhase({ ctx, localProductId: setup.productDetail.id, run: setup.run, page: setup.page, productId: productIdRef.current, manualCover: false, log: setup.log, persist: setup.persist }, "basic", async () => {
    const { productDetail, product, butlerSelection, servicePhone, scenicSpotLogs } = setup;

    const saveBasicInfo: typeof ensureBasicInfoApi = async (...args) => {
      try { return await ensureBasicInfoApi(...args); }
      catch (error) {
        if (isProductLineResolutionError(error)) setup.productLineBlocked = true;
        throw error;
      }
    };
    // runner 重试本阶段时清空 scenicSpotLogs，防止把上一轮未命中的景点
    // 单项重复记入 automation 日志。
    scenicSpotLogs.length = 0;
    const refreshedSupplierCode = refreshSupplierProductCodeForPlatformWrite(product, butlerSelection, productIdRef.current);
    if (refreshedSupplierCode) {
      productDetail.product = product as unknown as Record<string, unknown>;
      writeAutomationProduct(ctx, setup.productDetail.id, productDetail.product, "automating");
      const supplierCode = String((product.basicInfo as Record<string, unknown>).supplierProductCode);
      setup.log(`供应商产品编号已按本次写入时间重算：${refreshedSupplierCode}`);
      if (setup.basicInfoSaved) {
        const result = await saveBasicInfo(
          setup.page,
          product,
          productIdRef.current!,
          butlerSelection!,
          servicePhone,
          { skipProductLine: setup.productLineBlocked },
        );
        setup.log(`地接社已${result.localTravelAgency.selection === "defaulted" ? "自动选择" : "确认"}：${result.localTravelAgency.name || "未命名"}（${result.localTravelAgency.id}）`);
        setup.log(`供应商产品编号已通过基本信息 API 写入并完成回读：${supplierCode}`);
        return;
      }
    }
    const shouldRefill = shouldRefillBasicInfo({
      productId: productIdRef.current,
      basicInfoSaved: setup.basicInfoSaved,
      product: productDetail.product,
    });
    setup.log(`basic 阶段开始（reason=${shouldRefill.reason}）`);
    if (!productIdRef.current) throw new Error("产品 ID 缺失，无法继续后续阶段。");
    if (!ctx.agentControlled && shouldRefill.reason === "complete") {
      setup.log("basic 阶段已保存且产品数据完整，跳过重复填充");
      return;
    }
    const result = await saveBasicInfo(
      setup.page,
      product,
      productIdRef.current,
      butlerSelection!,
      servicePhone,
      { skipProductLine: setup.productLineBlocked },
    );
    setup.log(`地接社已${result.localTravelAgency.selection === "defaulted" ? "自动选择" : "确认"}：${result.localTravelAgency.name || "未命名"}（${result.localTravelAgency.id}）`);
    // 把景点未命中的单项沉淀到 automation 日志。
    for (const entry of scenicSpotLogs) setup.log(entry, "warning");
    // 仅当 VBK API 保存并完成远端回读后置位，失败路径不会误标。
    ctx.db.setBasicInfoSaved(setup.productDetail.id);
    setup.basicInfoSaved = true;
  });
}

