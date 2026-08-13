/**
 * computeReadiness 直接单测：覆盖 needs_user 阻塞的「可见性」红线（真实
 * run 09306ec1 修复），包括：
 *  - VBK 下拉中没有「安思科/1368298」时，basic 阶段 needs_user 必须作为
 *    actionable 待处理项出现在 issues 列表（不再走 hidden 计数）；
 *  - completion 由 issues.length 单一算出，不会出现「92% 但 0 pending」
 *    的假就绪态，也不会与 hidden 重复计入（修复前是 83% 但 1 pending）；
 *  - 用户主动取消（finalError 前缀为「用户中止」）时不生成新待处理项，
 *    与顶栏「已停止」不重复；
 *  - recovery 字段为空时不影响 schema / research task / automationBlockers
 *    路径。
 *
 * 本测试不复刻 main.ts readiness() 包装层（db.getProduct + productNotFound
 * 抛错）的 IO，直接驱动 ./src/main/readiness.ts 的纯函数 computeReadiness。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computeReadiness } from "../../src/main/readiness.js";
import type { AutomationRun, ResearchTask } from "../../shared/contracts.js";

function minimalProduct(): Record<string, unknown> {
  return {
    sales: { productType: "domesticShort", productForm: "groupTour", splitGroup: false },
    basicInfo: {
      supplierProductName: "测试产品",
      supplierProductCode: "TEST-1",
      subtitle: "测试副标题",
      days: 2,
      nights: 1,
      meetingCity: "太原",
      destinationCity: "太原",
      province: "山西",
      operationNotes: "测试运营备注",
    },
    operations: {
      transport: "charter",
      pickupCity: "太原",
      reusePickupForDropoff: true,
      hotelSource: "nonPlatform",
      mealsIncluded: false,
      hotelTier: "当地5钻酒店/-38",
      bookingControls: {
        advanceBooking: { days: 1, time: "12:00" },
        butler: { contactCardId: 1753732, displayName: "张三", providerId: 1279416 },
      },
    },
    presentation: {
      recommendation: "测试推荐语",
      features: "测试特点",
      recommendationCategory: "优选行程",
      recommendations: [
        { category: "优选行程", text: "A" },
        { category: "精选酒店", text: "B" },
        { category: "缤纷景点", text: "C" },
      ],
      cover: { source: "ctripLibrary", imageId: 1, imageUrl: "x", poi: "太原", description: "y", minQuality: 0 },
    },
    itinerary: [
      { day: 1, title: "第一天", description: "首日", hotel: "酒店", meals: "自理", spots: [{ name: "太原食品街", poiName: null, poiId: null }] },
      { day: 2, title: "第二天", description: "次日", hotel: "酒店", meals: "自理", spots: [{ name: "平遥古城", poiName: null, poiId: null }] },
    ],
    commercial: {
      packageName: "太原2天1晚私家团标准套餐",
      pricing: { currency: "CNY", adult: 1000, child: 500, minimumTravelers: 2 },
      inventory: { startDate: "2026-08-10", endDate: "2026-12-31", dailyQuota: 6 },
      release: { submitReview: false, publishAfterApproval: false, publicPriceCeiling: 3000, publicAuditRetries: 4 },
      terms: { inclusions: "x", exclusions: "y", bookingNotes: "z", refundPolicy: "w" },
    },
  };
}

function needsUserRun(phase: string, finalError: string, userInstruction?: string): AutomationRun {
  return {
    id: "run-1",
    status: "failed",
    phases: [{ phase, status: "failed" }],
    logs: [],
    recovery: {
      phases: {
        [phase]: {
          phase,
          state: "needs_user",
          attempts: [],
          finalError,
          ...(userInstruction ? { userInstruction } : {}),
        },
      },
    },
  };
}

test("needs_user 不在 VBK 下拉（contact not found）：issues 必须含一条 actionable 待处理项，不能 0 pending", () => {
  // 真实 run 09306ec1：basic 阶段因为 VBK 下拉中没有「安思科/1368298」
  // 而 needs_user。旧实现 hidden 计数会让 readiness 返回 92% 但 issues=[]，
  // 运营看不到「下一步要补什么」。新实现必须把这条阻塞暴露为 issues 项，
  // 标签含阶段名、详情含修复路径。
  const result = computeReadiness({
    product: minimalProduct(),
    researchTasks: [],
    automation: needsUserRun(
      "basic",
      "管家联系人「安思科」(ID 1368298)不在 VBK 联系人下拉中（缺少 ID / 姓名精确匹配项）；请在 VBK 维护该联系人或更新账号固定信息后再重试。可选：安思科-国际、其它用户",
      "请在 VBK 维护该联系人或更新账号固定信息后重试 basic 阶段。",
    ),
  });
  // 阻塞项可见：issues 必须包含「自动录入失败：basic」这一条 actionable 项。
  const blocked = result.issues.find((issue) => issue.label === "自动录入失败：basic");
  assert.ok(blocked, `issues 必须包含 basic 阶段的 needs_user 待处理项，实际：${JSON.stringify(result.issues)}`);
  // userInstruction 优先级高于 finalError；细节描述应包含可操作路径关键词。
  assert.match(blocked.detail, /VBK/);
  assert.match(blocked.detail, /重试/);
  // 不再 92% 但 0 pending：completion 必须由可见 issues 算出，且 ready=false。
  assert.equal(result.ready, false, "needs_user 阻塞时 readiness.ready 必须 false");
  // 单一来源：completion 由 issues.length 算出（1 issue = 92%）。修复前 hidden
  // + 1 issue 会算成 83%，是双计数的回归点。
  assert.equal(result.completion, 92, "单一可见 issue 时 completion 必须为 92%");
  assert.equal(result.issues.length, 1, "issues 列表必须含且仅含这条 needs_user 阻塞");
});

test("needs_user 仅给出 finalError（无 userInstruction）时，detail 必须包含「安思科」原始错误", () => {
  // 当 advisor 未能产生 userInstruction 时，回退到 finalError 原始错误。
  // 该路径上原始错误应该包含 contact 名字与 ID，让运营一眼看到是哪位
  // 联系人在 VBK 下拉里找不到。
  const result = computeReadiness({
    product: minimalProduct(),
    researchTasks: [],
    automation: needsUserRun(
      "basic",
      "管家联系人「安思科」(ID 1368298)不在 VBK 联系人下拉中；可选：安思科-国际、其它用户",
    ),
  });
  const blocked = result.issues.find((issue) => issue.label === "自动录入失败：basic");
  assert.ok(blocked);
  assert.match(blocked.detail, /安思科/);
  assert.match(blocked.detail, /1368298/);
});

test("needs_user 时优先用 rec.userInstruction 作详情，缺失时回退到 finalError，再缺失用默认文案", () => {
  // 详情优先级：userInstruction > finalError > 默认文案。
  // 每一档都禁止出现「detail 为空 → 不 push」的 92%/0 pending 假就绪态。
  const withUserInstruction = computeReadiness({
    product: minimalProduct(),
    researchTasks: [],
    automation: needsUserRun("basic", "原始错误：管家联系人下拉未找到 ID 1368298", "请手动核查后重试"),
  });
  assert.equal(withUserInstruction.issues[0]?.detail, "请手动核查后重试", "优先用 userInstruction");

  const withoutUserInstruction = computeReadiness({
    product: minimalProduct(),
    researchTasks: [],
    automation: needsUserRun("basic", "原始错误：管家联系人下拉未找到 ID 1368298"),
  });
  assert.equal(
    withoutUserInstruction.issues[0]?.detail,
    "原始错误：管家联系人下拉未找到 ID 1368298",
    "userInstruction 缺失时回退到 finalError",
  );

  const withoutAnyDetail = computeReadiness({
    product: minimalProduct(),
    researchTasks: [],
    automation: { ...needsUserRun("basic", ""), recovery: { phases: { basic: { phase: "basic", state: "needs_user", attempts: [] } } } },
  });
  assert.match(withoutAnyDetail.issues[0]?.detail ?? "", /自动录入失败/);
});

test("用户主动取消（finalError 前缀为「用户中止」）不生成新待处理项", () => {
  // 用户已知动作（点击「停止」）不重复产生任务，避免与顶部「已停止」重复。
  const result = computeReadiness({
    product: minimalProduct(),
    researchTasks: [],
    automation: needsUserRun(
      "basic",
      "用户中止了自动录入",
      "已停止当前自动录入，请在 VBK 核查当前页面后重新保存草稿。",
    ),
  });
  // 不应再追加「自动录入失败：basic」issues。
  assert.equal(
    result.issues.find((issue) => issue.label.startsWith("自动录入失败"))?.label,
    undefined,
    "用户主动取消时不应在 issues 里追加自动录入失败待处理项",
  );
});

test("needs_user 与 schema 阻断 / research task / automationBlockers 同时存在时，全部作为独立 issues 计入", () => {
  // 验证 needs_user 与其它来源的阻断不会被合并 / 吞掉：
  //   - schema 错误：product 缺 province 会产出 schema issue；
  //   - research task：未确认的 POI 任务会产出待处理项；
  //   - automationBlockers：privateTour 缺 vehicleResource 会产出「用车资源组」；
  //   - needs_user：basic 阶段被填进 issues。
  const product = minimalProduct();
  (product.sales as { productForm: string }).productForm = "privateTour";
  const incomplete = { ...product };
  delete (incomplete.basicInfo as Record<string, unknown>).province;
  const poiTask: ResearchTask = {
    id: "poi-1",
    label: "核查 太原食品街 的 VBK POI 映射",
    type: "vbk",
    status: "queued",
    state: "researching",
    detail: "x",
    evidence: [],
  };
  const result = computeReadiness({
    product: incomplete,
    researchTasks: [poiTask],
    automation: needsUserRun("basic", "contact not found", "请在 VBK 维护该联系人"),
  });
  assert.ok(result.issues.some((issue) => issue.label === "国家景区（省份）"));
  assert.ok(result.issues.some((issue) => issue.label === "核查 太原食品街 的 VBK POI 映射"));
  assert.ok(result.issues.some((issue) => issue.label === "用车资源组"));
  assert.ok(result.issues.some((issue) => issue.label === "自动录入失败：basic"));
  assert.equal(result.ready, false);
});

test("无 automation / 无 recovery 时不影响 readiness 计算路径", () => {
  const result = computeReadiness({
    product: minimalProduct(),
    researchTasks: [],
    // 显式不传 automation。
  });
  assert.equal(result.ready, true);
  assert.equal(result.completion, 100);
  assert.equal(result.issues.length, 0);
});
