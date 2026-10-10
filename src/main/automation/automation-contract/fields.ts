/**
 * VBK 录入字段契约：
 *   - VBK_PRODUCT_FIELDS：列出 VBK 录入每个阶段实际写入/读取的字段，
 *     每条含 path / label / phase / source / detail / check。
 *   - FieldSource / AutomationPhase / VbkFieldContract：类型定义。
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

import { HOTEL_TIER_VALUES } from "../../../shared/hotel-tiers.js";
import { hasSatisfiedVehicleResource } from "../../../shared/research-task-satisfaction.js";
import { productNeedsVehicleResource, requiresGuide, supportsSmallGroupSettings } from "../../../shared/product-form.js";
import {
  hasValidCoverPoMeta,
  hasValidItinerary,
  hasValidPresentationRecommendations,
  hasValidReleaseCeiling,
  textValue,
  asObject,
} from "../automation-contract.helpers.js";

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
  | "trafficLine"
  | "saleControl"
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
    detail: "需由 AI 规划生成，写入 VBK 基本信息。",
    check: (product) => textValue(asObject(product.basicInfo)?.subtitle).length > 0,
  },
  {
    path: "basicInfo.province",
    label: "国家景区（省份）",
    phase: "basic",
    source: "ai-planning",
    detail: "需由 AI 规划写入，用于匹配 VBK 省份下拉。",
    check: (product) => textValue(asObject(product.basicInfo)?.province).length > 0,
  },
  {
    path: "basicInfo.operationNotes",
    label: "运营备注",
    phase: "basic",
    source: "ai-planning",
    detail: "需由 AI 规划写入，填入 VBK 运营备注。",
    check: (product) => textValue(asObject(product.basicInfo)?.operationNotes).length > 0,
  },
  {
    path: "operations.butlerContact",
    label: "管家联系人",
    phase: "basic",
    source: "account-fixed",
    detail: "需先配置账号固定信息，创建产品时注入 VBK 联系人。",
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
    detail: "需由 AI 规划写入，填入 VBK 推荐语。",
    check: (product) => textValue(asObject(product.presentation)?.recommendation).length > 0,
  },
  {
    path: "presentation.features",
    label: "产品特点",
    phase: "presentation",
    source: "ai-planning",
    detail: "需由 AI 规划写入，填入 VBK 富文本。",
    check: (product) => textValue(asObject(product.presentation)?.features).length > 0,
  },
  {
    path: "presentation.recommendations",
    label: "推荐理由",
    phase: "presentation",
    source: "ai-planning",
    detail: "需 3 条；分类在白名单且不重复，文本非空。",
    check: hasValidPresentationRecommendations,
  },
  {
    path: "presentation.cover",
    label: "封面图",
    phase: "presentation",
    source: "ai-planning",
    detail: "需保存有效图库封面或人工封面；运营占位图仅可用于未提审草稿。",
    check: hasValidCoverPoMeta,
  },
  // itinerary 阶段
  {
    path: "itinerary",
    label: "每日行程",
    phase: "itinerary",
    source: "ai-planning",
    detail: "需由 AI 规划写入，包含可回读的 VBK POI。",
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
  {
    path: "operations.trafficLine",
    label: "线路及交通子产品",
    phase: "trafficLine",
    source: "vbk-runtime",
    detail: "母产品条款完成后，系统按已选交通方式、已核验行程及 VBK 站点候选创建往返子产品。",
    check: (product) => {
      const trafficLine = asObject(asObject(product.operations)?.trafficLine);
      if (!trafficLine || trafficLine.enabled === false) return true;
      const variants = trafficLine.variants;
      return Array.isArray(variants)
        && variants.length > 0
        && variants.every((variant) => variant === "flightRoundTrip" || variant === "trainRoundTrip");
    },
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
    detail: "需 AI 写入白名单 hotelTier，用于匹配 VBK 酒店档次。",
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
    detail: "已配置用车的产品需先匹配并回填 VBK 资源组。",
    check: (product) => productNeedsVehicleResource(product) ? hasSatisfiedVehicleResource(product) : true,
  },
  {
    path: "sales.guideIncluded",
    label: "随团导游",
    phase: "basic",
    source: "manual-only",
    detail: "跟团游必须确认包含随团导游。",
    check: (product) => {
      const sales = asObject(product.sales);
      return !requiresGuide(sales?.productForm) || sales?.guideIncluded !== false;
    },
  },
  {
    path: "sales.smallGroupSettings",
    label: "拼小团配置",
    phase: "saleControl",
    source: "vbk-runtime",
    detail: "跟团游 / 半自助需选择拼小团、广场拼团并设置最大人数 8。",
    check: (product) => {
      const sales = asObject(product.sales);
      if (!supportsSmallGroupSettings(sales?.productForm)) return true;
      return sales?.splitGroup === true && sales?.squareGroup === true && sales?.maxGroupSize === 8;
    },
  },
];