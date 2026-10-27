import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { itineraryInputContractError } from "../../src/main/planning/itinerary-input-contract.js";
import { explicitAlternativeGroups } from "../../src/main/planning/itinerary-input-contract/alternative.js";
import { extractLockedConstraints } from "../../src/main/agent/prompt-helpers.js";
import { constraintUserIdea } from "../../src/shared/product-idea-optimization.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

// 真实样本：万州 ae3316d7，采用 AI 优化稿后规划在 itineraryDraft 反复卡住。
const ORIGINAL = "DAY1：出发地-重庆万州-住万州\nDAY2：龙虹国家地质公园-张飞庙-住云阳\nDAY3：白帝城-三峡之巅-住奉节\nDAY4：巫峡-船观神女峰-三峡龙脊-神女大扶梯-住巫山或者万州\nDAY5：返程";
const OPTIMIZED = [
  "【DAY1】出发地 → 重庆万州，入住万州。",
  "（建议：抵达后安排万州城区轻松游览，如万州大瀑布或西山公园，晚餐品尝万州烤鱼。）",
  "【DAY2】龙虹国家地质公园 → 张飞庙，入住云阳。",
  "【DAY3】白帝城 → 三峡之巅，入住奉节。",
  "【DAY4】巫峡 → 船观神女峰 → 三峡龙脊 → 神女大扶梯，入住巫山或万州。",
  "（建议：神女大扶梯为登高步行为主，建议将大扶梯放在体力较充裕时段或作为可选项。）",
  "【DAY5】巫山或万州 → 返程。",
  "【服务建议】私家团含专车接送、独立用车与导游讲解、景区门票与区间交通/索道等。",
].join("\n");

function product(userIdea: string, originalIdea = ORIGINAL): ProductDetail {
  const detail = buildProductSnapshot({ destination: "万州", days: 5, productForm: "privateTour" });
  Object.assign(detail.product.basicInfo!, { userIdea, ideaOptimization: {
    optimizedIdea: OPTIMIZED, originalIdea, preservedItems: [], changes: [], recommendations: [], warnings: [],
    sourceFingerprint: "a".repeat(64), provider: "minimax", model: "m", optimizedAt: "2026-10-27T01:54:26.976Z",
  } });
  return detail;
}

test("采用优化稿时硬约束只解析用户原文，建议里的「或」不锁成二选一", () => {
  const detail = product(OPTIMIZED);
  assert.deepEqual(explicitAlternativeGroups(detail), []);
  const locked = extractLockedConstraints(detail, []);
  assert.deepEqual(locked.itineraryOrder.map((row) => [row.day, row.spots]), [
    [1, ["重庆万州"]], [2, ["龙虹国家地质公园", "张飞庙"]], [3, ["白帝城", "三峡之巅"]],
    [4, ["巫峡", "船观神女峰", "三峡龙脊", "神女大扶梯"]], [5, ["返程"]],
  ]);
  assert.ok(!locked.pois.some((poi) => /建议|服务|导游讲解|可选项/u.test(poi)), "建议与服务说明不是锁定景点");
});

test("优化稿建议的景点不再与「不能新增」互相矛盾：只走原文路线即可通过合同", () => {
  const detail = product(OPTIMIZED);
  const error = itineraryInputContractError(detail, [
    { day: 1, spots: [{ name: "重庆万州", kind: "free" }] },
    { day: 2, spots: [{ name: "龙虹国家地质公园" }, { name: "张飞庙" }] },
    { day: 3, spots: [{ name: "白帝城" }, { name: "三峡之巅" }] },
    { day: 4, spots: [{ name: "巫峡" }, { name: "船观神女峰" }, { name: "三峡龙脊" }, { name: "神女大扶梯" }] },
    { day: 5, spots: [{ name: "返程", kind: "free" }] },
  ]);
  assert.doesNotMatch(error ?? "", /二选一|万州大瀑布|西山公园|大扶梯放在/u);
});

test("用户手改过 userIdea 后以现文为准；未采用优化稿时原样返回", () => {
  assert.equal(constraintUserIdea(product(OPTIMIZED).product.basicInfo), ORIGINAL);
  assert.equal(constraintUserIdea(product("用户自己改过的版本").product.basicInfo), "用户自己改过的版本");
  assert.equal(constraintUserIdea({ userIdea: " 原文 " }), "原文");
  assert.equal(constraintUserIdea(undefined), "");
});
