import { ensureBasicInfoApi, isProductLineResolutionError } from "../../ctrip/basic-info/api.js";
import { advanceSavedProductWizardStage } from "../../ctrip/product-wizard.js";
import { shouldRefillBasicInfo } from "../../schema/schema.js";
import { writeAutomationProduct } from "../automation.main.persist.js";
import { runBasicInfoSaveWithCopyRepair } from "../basic-info-copy-repair.js";
import { refreshSupplierProductCodeForPlatformWrite } from "../automation.main.class.helpers.js";
import type { AutomationRunContext } from "../automation.main.context.js";
import { AutomationCancelledError } from "../automation.main.errors.js";
import type { AutomationSetup } from "../automation.main.run/setup.js";
import { executeDraftPhase } from "./phase.js";

export type BasicExecutionState = Pick<AutomationSetup,
  "productDetail" | "product" | "run" | "page" | "log" | "persist" | "butlerSelection"
  | "servicePhone" | "scenicSpotLogs" | "basicInfoSaved" | "productLineBlocked" | "wizardAdvanceOnly">;

/** Basic info shares supplier-code refresh, account context and remote verification in both modes. */
export function buildBasicExecute(
  ctx: AutomationRunContext,
  setup: BasicExecutionState,
  productIdRef: { current: string | undefined },
) {
  return async () => executeDraftPhase({ ctx, localProductId: setup.productDetail.id, run: setup.run, page: setup.page, productId: productIdRef.current, manualCover: false, log: setup.log, persist: setup.persist }, "basic", async () => {
    const assertBasicAdvanceCurrent = async () => {
      if (ctx.cancellationRequested.has(setup.productDetail.id)) throw new AutomationCancelledError();
      if (ctx.agentControlled && !ctx.assertWriteAuthorized) {
        throw new Error("基本信息下一步写入授权校验尚未就绪");
      }
      await ctx.assertWriteAuthorized?.(setup.productDetail.id, "basic");
      if (ctx.cancellationRequested.has(setup.productDetail.id)) throw new AutomationCancelledError();
    };
    if (setup.wizardAdvanceOnly.has("basic")) {
      const advanced = await advanceSavedProductWizardStage(
        setup.page, productIdRef.current!, "basicInfo", { assertCurrent: assertBasicAdvanceCurrent },
      );
      if (advanced.advanced) setup.log("基本信息已按 VBK 官方下一步推进，产品图文已解锁。");
      return;
    }
    const { productDetail, product, butlerSelection, servicePhone, scenicSpotLogs } = setup;

    const saveBasicInfo: typeof ensureBasicInfoApi = async (...args) => {
      const productPayload = args[1] as Record<string, any>;
      const executeBasicInfoApi = async () => {
        const result = await ensureBasicInfoApi(...args);
        return result;
      };
      try {
        return await runBasicInfoSaveWithCopyRepair({
          product: productPayload,
          save: executeBasicInfoApi,
          // 只改基本信息的自由文案，落库后仍由平台回读验收。
          persist: () => {
            productDetail.product = productPayload as unknown as Record<string, unknown>;
            writeAutomationProduct(ctx, setup.productDetail.id, productDetail.product, "automating");
          },
          log: setup.log,
          knownRejectedWords: ctx.db.listRejectedBasicInfoWords?.() ?? [],
          onLearned: (words, labels, detail) => {
            for (const word of words) {
              try {
                ctx.db.recordCopyFeedback({ word, module: "basicInfo", paths: [...labels], source: "basic-info-save", detail });
              } catch { /* 学习失败不影响本次修复。 */ }
            }
          },
        });
      } catch (error) {
        if (isProductLineResolutionError(error)) setup.productLineBlocked = true;
        throw error;
      }
    };
    const advanceWizard = async () => {
      const advanced = await advanceSavedProductWizardStage(
        setup.page, productIdRef.current!, "basicInfo", { assertCurrent: assertBasicAdvanceCurrent },
      );
      if (advanced.advanced) setup.log("基本信息已按 VBK 官方下一步推进，产品图文已解锁。");
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
        await advanceWizard();
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
      await advanceWizard();
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
    await advanceWizard();
  });
}

