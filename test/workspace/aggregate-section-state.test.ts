/**
 * 「销售控制」section 状态由 VBK productId 直接驱动的契约测试。
 *
 * 背景：saleControl section 没有映射任何自动化阶段（phaseNames 为空），
 * 它是 VBK 后台「新建产品 shell」的入口页。原先 aggregateSectionState
 * 对这种 section 一律返回 "idle"，导致产品在 VBK 中已保存产品壳后，
 * 左侧导航的「销售控制」行仍然是灰色未开始态，与右侧「VBK 浏览器」
 * 已经打开对应产品的视觉状态不一致。
 *
 * 本次最小 API 调整：aggregateSectionState 增加第 4 个可选参数 productId，
 * 对 phaseNames 为空的 section：
 *   - productId 是非空字符串（trim 后仍有内容） → "done"（绿）
 *   - 尚未保存 productId 且 currentPhase=saleControl → "running"（当前）
 *   - productId 为 undefined / 空串 / 纯空白 → "idle"（灰）
 *
 * 其余有 phaseNames 的 section（旧的产品信息 / 产品图文 / 行程描述 …）
 * 走原聚合逻辑，必须不受 productId 影响。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateSectionState,
  VBK_NAV_SECTIONS,
  type AutomationPhaseRow,
  type AutomationRecoveryMap,
} from "../../src/renderer/app/helpers/constants.js";

const saleControl = VBK_NAV_SECTIONS.find((section) => section.key === "saleControl");
const presentation = VBK_NAV_SECTIONS.find((section) => section.key === "presentation");
const itinerary = VBK_NAV_SECTIONS.find((section) => section.key === "itinerary");

assert.ok(saleControl, "VBK_NAV_SECTIONS 必须包含 saleControl section");
assert.ok(presentation, "VBK_NAV_SECTIONS 必须包含 presentation section");
assert.ok(itinerary, "VBK_NAV_SECTIONS 必须包含 itinerary section");
assert.equal(saleControl!.phaseNames.length, 0, "saleControl 是不映射阶段的入口页，phaseNames 必须为空");

const presentationCompleted: AutomationPhaseRow[] = [{ phase: "presentation", status: "completed" }];
const itineraryCompleted: AutomationPhaseRow[] = [{ phase: "itinerary", status: "completed" }];
const completedRecovery: AutomationRecoveryMap = {
  presentation: { phase: "presentation", state: "completed" },
  itinerary: { phase: "itinerary", state: "completed" },
};

test("销售控制：productId 为非空字符串时聚合为 done（绿）", () => {
  // 最常见路径：自动化已经在 VBK 创建了产品壳，product.productId 已保存。
  assert.equal(
    aggregateSectionState(saleControl!, [], undefined, "76522394"),
    "done",
    "已保存 VBK productId 时，销售控制 section 必须显示为 done / 绿。",
  );

  // 数字型 productId 不在本 API 范围（ProductDetail.productId 是 string | undefined），
  // 但为防回归，把"看起来非空"的字符串也包含进去（含前后空格的字符串 trim 后仍有内容）。
  assert.equal(
    aggregateSectionState(saleControl!, [], undefined, "  abc-123  "),
    "done",
    "前后带空白的 productId 视为已保存（trim 后非空 → done）。",
  );
});

test("销售控制：productId 为 undefined 时聚合为 idle（灰）", () => {
  assert.equal(
    aggregateSectionState(saleControl!, [], undefined),
    "idle",
    "未传 productId 时，销售控制 section 必须显示为 idle / 灰。",
  );
  assert.equal(
    aggregateSectionState(saleControl!, [], undefined, undefined),
    "idle",
    "显式 undefined productId 也必须聚合为 idle / 灰。",
  );
});

test("销售控制：首次自动录入 currentPhase=saleControl 时聚合为 running（当前）", () => {
  assert.equal(
    aggregateSectionState(saleControl!, [], undefined, undefined, "saleControl"),
    "running",
    "创建产品壳期间销售控制必须显示为当前运行阶段",
  );
  assert.equal(
    aggregateSectionState(saleControl!, [{ phase: "basic", status: "pending" }], undefined, undefined, "basic"),
    "idle",
    "产品信息尚未开始时不能被错误点亮",
  );
});

test("销售控制：productId 已保存时 done 优先于 currentPhase", () => {
  assert.equal(
    aggregateSectionState(saleControl!, [], undefined, "76522394", "saleControl"),
    "done",
    "产品壳已保存后销售控制必须保持完成态",
  );
});

test("销售控制：productId 为空白字符串时聚合为 idle（灰）", () => {
  // 空字符串 / 纯空白都视作「未保存」，不应让绿点亮起来。
  for (const blank of ["", " ", "   ", "\t", "\n", " \t\n "]) {
    assert.equal(
      aggregateSectionState(saleControl!, [], undefined, blank),
      "idle",
      `空白 productId（${JSON.stringify(blank)}）必须聚合为 idle / 灰，不应让绿点亮起。`,
    );
  }
});

test("销售控制：不基于运行/失败/recovery 推导 success — phases/recovery 不参与判定", () => {
  // 即便自动化进程正在 running / failed / needs_user，只要 productId 尚未保存，
  // 销售控制 section 仍应显示为 idle；反之只要 productId 已保存，无论 phases/recovery
  // 是什么状态，都显示 done。这把"销售控制"和"自动化阶段"彻底解耦。
  const lotsOfNoise: AutomationPhaseRow[] = [
    { phase: "basic", status: "running" },
    { phase: "presentation", status: "failed" },
    { phase: "itinerary", status: "completed" },
  ];
  const noisyRecovery: AutomationRecoveryMap = {
    basic: { phase: "basic", state: "needs_user" },
    presentation: { phase: "presentation", state: "failed" },
    itinerary: { phase: "itinerary", state: "completed" },
  };

  // 1) 没 productId 时：运行中/失败的自动化不能把销售控制点亮成 done / running / failed。
  assert.equal(
    aggregateSectionState(saleControl!, lotsOfNoise, noisyRecovery),
    "idle",
    "未保存 productId 时，phases/recovery 的任何信号都不能把销售控制点亮成 done。",
  );
  assert.equal(
    aggregateSectionState(saleControl!, lotsOfNoise, noisyRecovery, ""),
    "idle",
    "未保存 productId 时，phases/recovery 的任何信号都不能把销售控制点亮成 done。",
  );

  // 2) 已保存 productId 时：phases/recovery 哪怕全空，section 也是 done。
  assert.equal(
    aggregateSectionState(saleControl!, [], undefined, "76522394"),
    "done",
    "已保存 productId 时，phase 数据为空也必须聚合为 done / 绿。",
  );
  // 3) 已保存 productId 时：recovery 处于 needs_user / failed 也不能把销售控制显示为 failed。
  assert.equal(
    aggregateSectionState(saleControl!, lotsOfNoise, noisyRecovery, "76522394"),
    "done",
    "已保存 productId 时，销售控制必须仍是 done / 绿，不能被阶段失败误标红。",
  );
  // 4) 已保存 productId 时：phase 处于 running 也不能把销售控制显示为 running。
  assert.equal(
    aggregateSectionState(saleControl!, [{ phase: "basic", status: "running" }], undefined, "76522394"),
    "done",
    "已保存 productId 时，销售控制必须仍是 done / 绿，不能被阶段运行态误标蓝。",
  );
});

test("普通 presentation section 聚合行为不变：productId 不影响产品图文行的状态判定", () => {
  // 完整运行 → done；任意阶段失败 → failed；recovery needs_user → failed；advising → running；
  // 所有阶段 completed → done。这些断言必须与原行为一致，productId 是否传入不影响结果。
  const allCompleted: AutomationPhaseRow[] = [{ phase: "presentation", status: "completed" }];
  const oneFailed: AutomationPhaseRow[] = [{ phase: "presentation", status: "failed" }];
  const oneRunning: AutomationPhaseRow[] = [{ phase: "presentation", status: "running" }];

  // 1) 全 completed：productId 任意取值，结果都是 done。
  assert.equal(
    aggregateSectionState(presentation!, allCompleted, completedRecovery, "76522394"),
    "done",
    "presentation 全 completed + 已保存 productId → done",
  );
  assert.equal(
    aggregateSectionState(presentation!, allCompleted, completedRecovery),
    "done",
    "presentation 全 completed + 未传 productId → done（旧行为不变）",
  );
  assert.equal(
    aggregateSectionState(presentation!, allCompleted, completedRecovery, ""),
    "done",
    "presentation 全 completed + 空 productId → done",
  );

  // 2) 任意阶段 failed：必须 failed，productId 不能压过这个信号。
  assert.equal(
    aggregateSectionState(presentation!, oneFailed, completedRecovery, "76522394"),
    "failed",
    "presentation 阶段 failed 时，无论 productId 是什么，都必须 failed",
  );
  assert.equal(
    aggregateSectionState(presentation!, oneFailed, completedRecovery),
    "failed",
    "presentation 阶段 failed 时，必须 failed（旧行为不变）",
  );

  // 3) 阶段 running：必须 running。
  assert.equal(
    aggregateSectionState(presentation!, oneRunning, completedRecovery, "76522394"),
    "running",
    "presentation 阶段 running 时，无论 productId 是什么，都必须 running",
  );

  // 4) recovery needs_user：必须 failed，productId 不能压过这个信号。
  const needsUserRecovery: AutomationRecoveryMap = {
    presentation: { phase: "presentation", state: "needs_user" },
  };
  assert.equal(
    aggregateSectionState(presentation!, allCompleted, needsUserRecovery, "76522394"),
    "failed",
    "presentation recovery needs_user 时，无论 productId 是什么，都必须 failed",
  );

  // 5) recovery advising：必须 running。
  const advisingRecovery: AutomationRecoveryMap = {
    presentation: { phase: "presentation", state: "advising" },
  };
  assert.equal(
    aggregateSectionState(presentation!, allCompleted, advisingRecovery, "76522394"),
    "running",
    "presentation recovery advising 时，无论 productId 是什么，都必须 running",
  );
});

test("普通 itinerary section 聚合行为不变：productId 不影响行程描述行的状态判定", () => {
  // 反向 smoke：另一个普通 section 也要保证 productId 不影响聚合。
  const allCompleted: AutomationPhaseRow[] = [{ phase: "itinerary", status: "completed" }];
  assert.equal(
    aggregateSectionState(itinerary!, allCompleted, completedRecovery, "76522394"),
    "done",
    "itinerary 全 completed + 已保存 productId → done",
  );
  assert.equal(
    aggregateSectionState(itinerary!, allCompleted, completedRecovery),
    "done",
    "itinerary 全 completed + 未传 productId → done（旧行为不变）",
  );

  // itinerary 没找到任何映射 phase 时（旧行为：返回 idle），productId 不能改变这个判定。
  assert.equal(
    aggregateSectionState(itinerary!, [], undefined, "76522394"),
    "idle",
    "itinerary 没映射到任何 phase 时，即使 productId 已保存也不能变 done，"
    + "因为本契约明确说「不为其它 section 编造 success」。",
  );
});
