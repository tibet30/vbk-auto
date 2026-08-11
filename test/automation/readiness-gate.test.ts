import test from "node:test";
import assert from "node:assert/strict";
import { automationBlockers, productSchema } from "../../src/main/automation/schema/schema.js";
import { isCoverResearchTaskSatisfiedByProduct } from "../../src/main/minimax/minimax.js";

/**
 * 完整合法规划产物（跟团游）：
 *   - basicInfo / presentation / itinerary / operations 全部齐全；
 *   - 仅缺 commercial 三件套（packageName + pricing + inventory + terms）；
 *   - 用来断言「商业类字段不阻断 readiness」等回归契约。
 */
const baseProduct = {
  sales: { productType: "domesticShort", productForm: "groupTour", splitGroup: false },
  basicInfo: {
    supplierProductName: "太原2天1晚跟团游",
    supplierProductCode: "P001",
    subtitle: "太原经典行程",
    days: 1,
    nights: 0,
    meetingCity: "太原",
    destinationCity: "太原",
    province: "山西",
    operationNotes: "无",
  },
  operations: {
    hotelSource: "nonPlatform" as const,
    hotelTier: "当地3钻酒店/-3" as const,
    mealsIncluded: false,
    pickupCity: "太原",
    transport: "charter" as const,
    reusePickupForDropoff: true,
    bookingControls: {
      butler: { contactCardId: 1, displayName: "管家A", providerId: 100 },
    },
  },
  presentation: {
    recommendation: "推荐",
    features: "特色",
    recommendations: [
      { category: "优选行程", text: "节奏舒适不赶路" },
      { category: "精选酒店", text: "当地 3 钻酒店含早餐" },
      { category: "缤纷景点", text: "覆盖晋祠与博物院" },
    ],
    cover: {
      source: "ctripLibrary" as const,
      poi: "晋祠博物馆",
      description: "横版晋祠外景或代表性造像",
      minQuality: 3,
    },
  },
  itinerary: [
    {
      day: 1,
      title: "太原接站—晋祠",
      spots: [{ name: "晋祠博物馆", poiName: "晋祠博物馆", poiId: 79413 }],
      description: "专车接站游览晋祠。",
      hotel: "太原市区舒适酒店",
      meals: "早餐自理；午餐自理；晚餐自理",
    },
  ],
};

const commercial = {
  packageName: "标准套餐",
  pricing: { adult: 599, child: 399, minimumTravelers: 2 },
};

const validProduct = {
  ...baseProduct,
  commercial,
};

test("缺少 commercial 不再作为规划 / 草稿阶段阻塞项", () => {
  const blockers = automationBlockers(baseProduct);
  assert.deepEqual(blockers.map((item) => item.label), []);
});

test("缺少 packageName 不再作为规划 / 草稿阶段阻塞项", () => {
  const blockers = automationBlockers({ ...baseProduct, commercial: { pricing: commercial.pricing } });
  assert.deepEqual(blockers.map((item) => item.label), []);
});

test("缺少 pricing 不再作为规划 / 草稿阶段阻塞项", () => {
  const blockers = automationBlockers({ ...baseProduct, commercial: { packageName: commercial.packageName } });
  assert.deepEqual(blockers.map((item) => item.label), []);
});

test("仅有 packageName 和 pricing 的跟团游通过", () => {
  assert.deepEqual(automationBlockers({ ...baseProduct, commercial }), []);
});

test("缺少 inventory 和 terms 不阻塞", () => {
  const blockers = automationBlockers({ ...baseProduct, commercial });
  assert.equal(blockers.some((item) => item.label === "库存" || item.label === "条款"), false);
});

test("私家团缺少用车资源组会被拦下", () => {
  const product = {
    ...baseProduct,
    sales: { ...baseProduct.sales, productForm: "privateTour" },
    commercial,
  };
  const blockers = automationBlockers(product);
  assert.deepEqual(blockers.map((item) => item.label), ["用车资源组"]);
});

test("manualUpload 封面会被 readiness 明确阻断", () => {
  const product = {
    ...baseProduct,
    presentation: {
      ...baseProduct.presentation,
      cover: {
        source: "manualUpload",
        fileId: "11111111-1111-1111-1111-111111111111",
        originalName: "demo.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1024,
        poi: "云冈石窟",
        description: "横版云冈石窟外景",
        minQuality: 3,
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  };
  const blockers = automationBlockers(product);
  assert.ok(blockers.some((item) => item.label === "封面来源"), "manualUpload 封面必须阻断");
  const detail = blockers.find((item) => item.label === "封面来源");
  assert.match(detail?.detail ?? "", /手动上传封面/);
});

test("ctripLibrary 封面不阻断 readiness", () => {
  const product = {
    ...baseProduct,
    presentation: {
      ...baseProduct.presentation,
      cover: { source: "ctripLibrary", poi: "云冈石窟", description: "横版云冈石窟外景或代表性造像", minQuality: 3 },
    },
  };
  const blockers = automationBlockers(product);
  assert.equal(blockers.some((item) => item.label === "封面来源"), false);
});

test("ctripLibrary 封面缺 poi / description 仍会阻断（POI meta 是 ai-planning 必填）", () => {
  const product = {
    ...baseProduct,
    presentation: {
      ...baseProduct.presentation,
      cover: { source: "ctripLibrary", minQuality: 3 },
    },
  };
  const blockers = automationBlockers(product);
  assert.ok(blockers.some((item) => /封面图/.test(item.label)), "封面图 POI meta 缺失必须阻断");
});

test("presentation.recommendations 缺一条仍会被 readiness 明确阻断（3 条强制）", () => {
  const product = {
    ...baseProduct,
    presentation: {
      ...baseProduct.presentation,
      recommendations: [
        { category: "优选行程", text: "A" },
        { category: "精选酒店", text: "B" },
      ],
    },
  };
  const blockers = automationBlockers(product);
  assert.ok(blockers.some((item) => /推荐理由/.test(item.label)), "推荐理由必须 3 条是 AI 规划必填");
  const detail = blockers.find((item) => /推荐理由/.test(item.label));
  assert.match(detail?.detail ?? "", /3 条/);
});

test("presentation.recommendations 重复 category 仍会被 readiness 明确阻断", () => {
  const product = {
    ...baseProduct,
    presentation: {
      ...baseProduct.presentation,
      recommendations: [
        { category: "优选行程", text: "A" },
        { category: "优选行程", text: "B" },
        { category: "缤纷景点", text: "C" },
      ],
    },
  };
  const blockers = automationBlockers(product);
  assert.ok(blockers.some((item) => /推荐理由/.test(item.label)), "推荐理由 category 重复必须阻断");
});

test("presentation.recommendations 非白名单 category 仍会被 readiness 明确阻断", () => {
  const product = {
    ...baseProduct,
    presentation: {
      ...baseProduct.presentation,
      recommendations: [
        { category: "优选行程", text: "A" },
        { category: "精选酒店", text: "B" },
        { category: "非法分类", text: "C" },
      ],
    },
  };
  const blockers = automationBlockers(product);
  assert.ok(blockers.some((item) => /推荐理由/.test(item.label)));
});

test("私家团配齐用车资源组后通过", () => {
  const product = {
    ...baseProduct,
    sales: { ...baseProduct.sales, productForm: "privateTour" },
    commercial,
    operations: { ...baseProduct.operations, vehicleResource: { resourceGroupId: 88231, resourceGroupName: "太原用车组" } },
  };
  assert.deepEqual(automationBlockers(product), []);
});

test("完整 cover 只覆盖 image research task", () => {
  const product = {
    ...validProduct,
    presentation: {
      ...validProduct.presentation,
      cover: { source: "ctripLibrary", poi: "云冈石窟", description: "横版云冈石窟外景或代表性造像", minQuality: 3 },
    },
  };
  assert.equal(isCoverResearchTaskSatisfiedByProduct({ type: "image" }, product), true);
  for (const type of ["vbk", "web", "cost"]) {
    assert.equal(isCoverResearchTaskSatisfiedByProduct({ type }, product), false);
  }
});

test("inventory 存在但结构非法时 productSchema 报错", () => {
  const result = productSchema.safeParse({
    ...validProduct,
    commercial: { ...commercial, inventory: { startDate: "invalid", endDate: "2026-12-31", dailyQuota: 10 } },
  });
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((issue) => issue.path.join(".") === "commercial.inventory.startDate"));
});

test("terms 存在但结构非法时 productSchema 报错", () => {
  const result = productSchema.safeParse({
    ...validProduct,
    commercial: { ...commercial, terms: { inclusions: "" } },
  });
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((issue) => issue.path.join(".") === "commercial.terms.inclusions"));
});
