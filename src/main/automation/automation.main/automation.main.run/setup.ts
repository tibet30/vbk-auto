/**
 * automation.main.run setup 阶段：
 *   - 拉取 productDetail / 归一化 product 类型 / 检查 blockers
 *   - 解析 butlerSelection + servicePhone（按需）
 *   - 创建或 resume AutomationRun，构造 log/persist 闭包
 *   - 计算 draftPhases + startIndex，校验中间阶段重试前置条件
 *
 * 产物 AutomationSetup 把所有 setup 期间产生的闭包状态打包返回，
 * 给 handlers.ts 复用，避免再次重复 resolve。
 */

import { randomUUID } from "node:crypto";
import { getVbkRequestPage } from "../../../infrastructure/vbk-request-page.js";
import {
  automationBlockers,
  parseProduct,
  pickKeySpotsFromItinerary,
} from "../../schema/schema.js";
import type {
  AutomationRun,
  ContactCardSelection,
  ProductDetail,
} from "../../../../shared/contracts.js";
import { recoverCreatedShell } from "../automation.main.recover-shell.js";
import { normalizeUnsupportedProductTypeBeforeShell } from "../automation.main.product-type.js";
import { draftPhasesFor } from "../automation.main.phases.js";
import {
  resourceRecoveryPhases,
} from "../automation.main.resource-handlers.js";
import { prepareAutomationResumeRun } from "../automation.main.resume-state.js";
import { automationAccountContext, automationSession } from "../runtime/index.js";
import { writeAutomationProduct } from "../automation.main.persist.js";
import { inspectManualCoverAsset } from "../../manual-cover-asset.js";
import {
  placeholderDraftOnly,
  readActiveCoverFallback,
} from "../../../../shared/cover-fallback.js";
import { loadPlaceholderCoverAsset } from "../../placeholder-cover-asset.js";
import { hasProductLineResolutionFailure } from "../../ctrip/basic-info/api.js";
import type { AutomationRunContext } from "../automation.main.context.js";

type AutomationLogLevel = "info" | "warning" | "error";

export interface AutomationSetup {
  productDetail: ProductDetail;
  product: ReturnType<typeof parseProduct>;
  draftPhases: string[];
  startIndex: number;
  run: AutomationRun;
  basicInfoSaved: boolean;
  productLineBlocked: boolean;
  butlerSelection: ContactCardSelection | null;
  servicePhone: string;
  keySpots: string[];
  scenicSpotLogs: string[];
  page: Awaited<ReturnType<typeof getVbkRequestPage>>;
  log: (message: string, level?: AutomationLogLevel) => void;
  persist: () => void;
  normalizedProductTypeChanged: boolean;
}

/**
 * 阶段 1：拉取产品 + 归一 + blocker 检查 + 解析账号上下文（按需） + 创建/恢复 AutomationRun。
 * 失败时抛错（preflight 失败 / 远程草稿未创建 / 中间阶段不在 draftPhases 内 / ...），
 * 由 runAutomation 的 catch 接住。
 */
export async function prepareAutomationSetup(
  ctx: AutomationRunContext,
  localProductId: string,
  retryFrom: string | undefined,
): Promise<AutomationSetup> {
  const productDetail = ctx.db.getProduct(localProductId);
  if (!productDetail) throw new Error("产品不存在");

  const normalizedProductType = normalizeUnsupportedProductTypeBeforeShell(
    productDetail.product,
    productDetail.productId,
  );
  productDetail.product = normalizedProductType.product;
  const product = parseProduct(productDetail.product);

  if (readActiveCoverFallback(productDetail.product)) {
    if (!placeholderDraftOnly(productDetail.product)) {
      throw new Error("运营占位图仅允许录入未提审、未上架的草稿。");
    }
    loadPlaceholderCoverAsset();
  }

  const blockers = automationBlockers(productDetail.product);
  const manualCoverIssue = inspectManualCoverAsset(productDetail.product).issue;
  if (manualCoverIssue) blockers.push({ label: "封面图片规格", detail: manualCoverIssue });
  if (blockers.length) {
    throw new Error(`录入前检查未通过：${blockers.map((item) => item.label).join("、")}`);
  }

  let mutableRetryFrom = retryFrom;
  if (mutableRetryFrom === "saleControl") {
    await recoverCreatedShell(ctx, productDetail);
    mutableRetryFrom = "basic";
  }

  const draftPhases = resourceRecoveryPhases(
    product,
    draftPhasesFor(product),
    productDetail.automation,
    mutableRetryFrom,
  );
  const startIndex = mutableRetryFrom ? draftPhases.indexOf(mutableRetryFrom) : 0;
  if (mutableRetryFrom && startIndex < 0) throw new Error(`当前产品没有阶段：${mutableRetryFrom}`);
  if (mutableRetryFrom && !productDetail.productId) {
    throw new Error("远程草稿尚未创建，不能从中间阶段重试。");
  }

  let basicInfoSaved = productDetail.basicInfoSaved ?? false;
  let productLineBlocked = hasProductLineResolutionFailure(
    productDetail.automation?.recovery?.phases.basic,
  );

  const { butlerSelection, servicePhone } = automationAccountContext(
    ctx.db, productDetail.product, startIndex === 0 || !basicInfoSaved,
  );

  const keySpots = pickKeySpotsFromItinerary(productDetail.product);
  const scenicSpotLogs: string[] = [];

  if (mutableRetryFrom && !productDetail.automation) {
    throw new Error("没有可重试的自动录入记录。");
  }

  const run: AutomationRun = mutableRetryFrom
    ? prepareAutomationResumeRun(productDetail.automation!, draftPhases, mutableRetryFrom)
    : {
        id: randomUUID(),
        status: "running",
        phases: draftPhases.map((phase) => ({ phase, status: "pending" })),
        logs: [],
      };

  // Acquire the request surface before publishing a running record. A connection
  // failure leaves the previous durable checkpoint intact and retryable.
  const page = await getVbkRequestPage(ctx.browser);
  const { persist, log } = automationSession(ctx, localProductId, run);
  run.currentPhase = mutableRetryFrom ?? (productDetail.productId ? "basic" : "saleControl");
  persist();

  if (normalizedProductType.changed) {
    log("旧产品类型已在创建远端草稿前归一为境内短途，避免缺少大交通卡片导致校验失败。", "warning");
  }

  writeAutomationProduct(ctx, localProductId, productDetail.product, "automating");

  return {
    productDetail,
    product,
    draftPhases,
    startIndex,
    run,
    basicInfoSaved,
    productLineBlocked,
    butlerSelection,
    servicePhone,
    keySpots,
    scenicSpotLogs,
    page,
    log,
    persist,
    normalizedProductTypeChanged: normalizedProductType.changed,
  };
}
