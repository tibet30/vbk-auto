/**
 * 自动化「必填 VBK 字段」契约与早期 readiness gate：
 *
 *   - VBK_PRODUCT_FIELDS：列出 VBK 录入每个阶段实际写入/读取的字段，
 *     每条含 path / label / phase / source / detail / check。
 *   - evaluateAutomationContract(product)：扫一遍产品，返回缺/坏字段
 *     + 阶段 + 人类可读提示；readiness / 自动化起跑前的单一真实来源。
 *   - assertPresentationReadyForVbk(product)：fillAndSavePresentation 内部
 *     防御闸门——即便 readiness 通过，VBK 写入前也再校验一次（defense in depth）。
 *
 * 「source」决定 readiness 行为：
 *   - "ai-planning"   ：规划阶段 AI 必须产出并写入；缺失/坏 → 阻断。
 *   - "ai-soft"       ：AI 写但不强制（缺则回退默认值）。
 *   - "account-fixed" ：从账号 AccountFixedInfo 读，main 端自动注入。
 *   - "vbk-runtime"   ：由 VBK 当前页下拉匹配在自动化阶段内回填；运营
 *                       核查可前置为 research task，但 readiness 不阻断。
 *   - "manual-only"   ：只能由人工 / 账号固定信息在运营面板写入。
 *
 * 配套测试：test/automation/automation-contract.test.ts
 *   - G1: presentation.recommendations 缺失/坏/重复让 readiness 不通过
 *         并明确告诉运营「恰好 3 条」；
 *   - G2: 一个合法 planning 输出的 presentation 会被契约视为就绪；
 *   - G3: assertPresentationReadyForVbk 会在 VBK 写入前就抛错；
 *   - G4: 列出每个 VBK 实际写入/读取的字段，验证要么被契约覆盖、
 *         要么是 vbk-runtime / manual-only / account-fixed exception。
 */

import { HOTEL_TIER_VALUES } from "../../shared/hotel-tiers.js";
import { hasSatisfiedVehicleResource } from "../../shared/research-task-satisfaction.js";
import { readCover } from "../operations/cover-info.js";
import {
  hasValidCoverPoMeta,
  hasValidItinerary,
  hasValidPresentationRecommendations,
  hasValidReleaseCeiling,
  isPrivateTour,
  textValue,
  asObject,
} from "./automation-contract.helpers.js";

/** 字段的来源分类，决定 readiness 行为。 */
export type FieldSource =
  | "ai-planning"
  | "ai-soft"
  | "account-fixed"
  | "vbk-runtime"
  | "manual-only";

/** 字段写入所对应的 VBK 自动化阶段。 */
export type AutomationPhase =
  | "basic"
  | "presentation"
  | "itinerary"
  | "package"
  | "pricingInventory"
  | "terms"
  | "hotelResource"
  | "vehicleResource"
  | "preflight";

/** 单一字段契约。 */
export interface VbkFieldContract {
  /** product JSON 内的点路径（如 "presentation.recommendations"）。 */
  path: string;
  /** 人类可读 label（与 UI 措辞保持一致；中文为主）。 */
  label: string;
  /** VBK 录入阶段。 */
  phase: AutomationPhase;
  /** 字段来源：决定 readiness 是否阻断。 */
  source: FieldSource;
  /** 缺字段 / 不合规时拼到 readiness issue 的 detail。 */
  detail: string;
  /** 校验函数：返回 true 表示已就绪。 */
  check: (product: Record<string, unknown>) => boolean;
}

/**
 * VBK 录入每个阶段实际写入/读取的字段契约。
 * 任何新增 VBK 写入都必须先在这里登记。
 */
export const VBK_PRODUCT_FIELDS: readonly VbkFieldContract[] = [
  // basic 阶段
  {
    path: "basicInfo.subtitle",
    label: "副标题",
    phase: "basic",
    source: "ai-planning",
    detail: "副标题由 AI 规划阶段生成；缺则 VBK 基本信息页会留空。",
    check: (product) => textValue(asObject(product.basicInfo)?.subtitle).length > 0,
  },
  {
    path: "basicInfo.province",
    label: "国家景区（省份）",
    phase: "basic",
    source: "ai-planning",
    detail: "省份由 AI 规划阶段写入；缺则 VBK 省份下拉匹配失败。",
    check: (product) => textValue(asObject(product.basicInfo)?.province).length > 0,
  },
  {
    path: "basicInfo.operationNotes",
    label: "运营备注",
    phase: "basic",
    source: "ai-planning",
    detail: "运营备注由 AI 规划阶段写入；缺则 VBK 运营备注留空。",
    check: (product) => textValue(asObject(product.basicInfo)?.operationNotes).length > 0,
  },
  {
    path: "operations.butlerContact",
    label: "管家联系人",
    phase: "basic",
    source: "account-fixed",
    detail: "管家联系人由账号固定信息在创建产品时注入，自动化阶段不重写；缺则 VBK 联系人下拉无可选项。",
    check: (product) => {
      const operations = asObject(product.operations);
      const bookingControls = asObject(operations?.bookingControls);
      const butler = asObject(bookingControls?.butler);
      if (!butler) return false;
      return Number.isInteger(butler.contactCardId)
        && Number.isInteger(butler.providerId)
        && textValue(butler.displayName).length > 0;
    },
  },
  // presentation 阶段
  {
    path: "presentation.recommendation",
    label: "推荐语",
    phase: "presentation",
    source: "ai-planning",
    detail: "推荐语由 AI 规划阶段写入；缺则 VBK 推荐语输入框空。",
    check: (product) => textValue(asObject(product.presentation)?.recommendation).length > 0,
  },
  {
    path: "presentation.features",
    label: "产品特点",
    phase: "presentation",
    source: "ai-planning",
    detail: "产品特点由 AI 规划阶段写入；缺则 VBK 富文本编辑器空。",
    check: (product) => textValue(asObject(product.presentation)?.features).length > 0,
  },
  {
    path: "presentation.recommendations",
    label: "推荐理由（3 条）",
    phase: "presentation",
    source: "ai-planning",
    detail: "推荐理由必须恰好 3 条、category 在白名单、互不重复；缺则 VBK 推荐理由写入失败。",
    check: hasValidPresentationRecommendations,
  },
  {
    path: "presentation.cover",
    label: "封面图（携程图库）",
    phase: "presentation",
    source: "ai-planning",
    detail: "封面图由 AI 规划阶段写入 poi/description/minQuality，imageId/imageUrl 由 VBK 选图回填。",
    check: hasValidCoverPoMeta,
  },
  // itinerary 阶段
  {
    path: "itinerary",
    label: "每日行程",
    phase: "itinerary",
    source: "ai-planning",
    detail: "每日行程由 AI 规划阶段写入；缺则 VBK 行程描述无法填写。",
    check: hasValidItinerary,
  },
  // package / pricing / inventory / terms → 草稿态缺也允许（运营/上架时回填）
  {
    path: "commercial.packageName",
    label: "套餐名称",
    phase: "package",
    source: "vbk-runtime",
    detail: "套餐名称在 VBK 套餐页由自动化阶段直接写入；缺不会阻断 readiness。",
    check: () => true,
  },
  {
    path: "commercial.pricing",
    label: "套餐定价",
    phase: "pricingInventory",
    source: "vbk-runtime",
    detail: "套餐定价在 VBK 价格库存页由自动化阶段直接写入；缺不会阻断 readiness。",
    check: () => true,
  },
  {
    path: "commercial.inventory",
    label: "库存",
    phase: "pricingInventory",
    source: "vbk-runtime",
    detail: "库存由 VBK 价格库存页直接写入；缺不会阻断 readiness。",
    check: () => true,
  },
  {
    path: "commercial.terms",
    label: "条款",
    phase: "terms",
    source: "vbk-runtime",
    detail: "条款由 VBK 条款页直接写入；缺不会阻断 readiness。",
    check: () => true,
  },
  // release 草稿安全
  {
    path: "commercial.release",
    label: "发布控制（publicPriceCeiling）",
    phase: "preflight",
    source: "ai-soft",
    detail: "publicPriceCeiling 由 AI 规划阶段写入；缺则按草稿态安全处理。",
    check: hasValidReleaseCeiling,
  },
  // 资源
  {
    path: "operations.hotelTier",
    label: "AI 规划：hotelTier 字段",
    phase: "basic",
    source: "ai-planning",
    detail: "AI 规划阶段必须写入合法 hotelTier（白名单见 HOTEL_TIER_VALUES）；缺则 VBK lodging tier 下拉无可选。",
    check: (product) => {
      const tier = textValue(asObject(product.operations)?.hotelTier);
      return (HOTEL_TIER_VALUES as readonly string[]).includes(tier);
    },
  },
  {
    path: "operations.vehicleResource",
    label: "用车资源组",
    phase: "vehicleResource",
    source: "vbk-runtime",
    detail: "私家团用车资源组由 VBK 资源组接口匹配后回填；缺则 VBK 资源组下拉不可用。",
    check: (product) => isPrivateTour(product) ? hasSatisfiedVehicleResource(product) : true,
  },
];

/**
 * 检查项结果。failures 只列阻断性字段（ai-planning / account-fixed）；
 * vbk-runtime / manual-only / ai-soft 失败不计入。
 */
export interface AutomationContractResult {
  failures: Array<{
    field: VbkFieldContract;
    /** 人类可读原因；用于 readiness issue / assert 错误文案。 */
    reason: string;
  }>;
  /** 仍可启动自动化，但运营 / 自动化阶段需要回填的字段清单。 */
  runtimeExceptions: Array<{
    field: VbkFieldContract;
    reason: string;
  }>;
  /** 整个产品契约是否通过（readiness = true）。 */
  ready: boolean;
}

/**
 * 评估产品对 VBK 录入契约的满足情况。
 * 这是 readiness 阶段 + 自动化起跑前的「单一真实来源」。
 */
export function evaluateAutomationContract(product: Record<string, unknown>): AutomationContractResult {
  const failures: AutomationContractResult["failures"] = [];
  const runtimeExceptions: AutomationContractResult["runtimeExceptions"] = [];
  for (const field of VBK_PRODUCT_FIELDS) {
    let ok = false;
    try {
      ok = field.check(product);
    } catch {
      ok = false;
    }
    if (ok) continue;
    if (field.source === "ai-planning" || field.source === "account-fixed") {
      failures.push({ field, reason: `${field.label}未就绪：${field.detail}` });
    } else {
      runtimeExceptions.push({ field, reason: `${field.label}由 ${field.source} 阶段回填：${field.detail}` });
    }
  }
  return { failures, runtimeExceptions, ready: failures.length === 0 };
}

/**
 * 防御深度闸门：fillAndSavePresentation 进入 VBK 写入前再校验一次。
 * 即便 readiness 通过、AI 已写、商业逻辑错误等导致产品被改动，
 * VBK 阶段自身仍能在第一行就抛错。
 */
export function assertPresentationReadyForVbk(product: Record<string, unknown>): void {
  const presentation = asObject(product.presentation);
  if (!presentation) {
    throw new Error("产品图文（presentation）尚未生成，请先在 AI 规划阶段补全推荐语、产品特点、推荐理由。");
  }
  if (textValue(presentation.recommendation).length === 0) {
    throw new Error("产品图文缺少推荐语，请先在 AI 规划阶段补全 presentation.recommendation。");
  }
  if (textValue(presentation.features).length === 0) {
    throw new Error("产品图文缺少产品特点，请先在 AI 规划阶段补全 presentation.features。");
  }
  if (!hasValidPresentationRecommendations(product)) {
    throw new Error("推荐理由必须恰好 3 条：category 必须在 15 项白名单内、互不重复、文本非空。请回到 AI 规划阶段补全 presentation.recommendations。");
  }
  const cover = readCover(product);
  if (!cover) {
    throw new Error("产品图文缺少封面图，请先在 AI 规划阶段补全 presentation.cover（poi / description / minQuality 必填）。");
  }
  if (cover.source === "manualUpload") {
    throw new Error("产品图文封面来自手动上传，自动化阶段不支持；请改用携程图库（ctripLibrary）或改为人工处理。");
  }
  if (cover.source === "ctripLibrary") {
    if (textValue(cover.poi).length === 0) {
      throw new Error("产品图文封面缺少代表景点（poi），请先在 AI 规划阶段补全 presentation.cover.poi。");
    }
    if (textValue(cover.description).length === 0) {
      throw new Error("产品图文封面缺少描述（description），请先在 AI 规划阶段补全 presentation.cover.description。");
    }
  }
}

/**
 * 产品 JSON 文档化存储位置：
 *   - 表：products.product_json（TEXT，UTF-8 JSON 字符串）
 *   - 文件：dataPath（app.getPath("userData")）/vbk-desktop.sqlite
 *   - 写入时机：
 *     1. createProduct：插入初始 product（仅骨架 + 空 presentation/itinerary）
 *     2. 规划 AI 输出 → stage-runner.executeStageOutput → runtime.writeModule
 *        → applyProductPatchSafe → db.updateProduct
 *     3. 运营手动复核（基础信息/管家/价格/封面）→ applyManualReviewField
 *        → db.updateProduct
 *     4. 自动化阶段回填（hotelResource.resourceId/Name）→ fillAndSaveXxx
 *        → db.updateProduct
 *   - 读取时机：
 *     - IPC products.get → db.getProduct → parseAndNormalizeProductJson
 *     - 规划 deep validation → runtime.loadCurrentProduct
 *     - automationBlockers → evaluateAutomationContract
 *     - 自动化 fillAndSave* 校验 → assertPresentationReadyForVbk 等
 */
export const PRODUCT_JSON_LOCATION = {
  table: "products",
  column: "product_json",
  format: "JSON 字符串（TEXT，UTF-8）",
  schema: "src/main/automation/schema/schema-definitions.ts#productSchema",
  persistence: "better-sqlite3 → dataPath/vbk-desktop.sqlite",
  dataPath: "app.getPath('userData')/vbk-desktop.sqlite",
} as const;
