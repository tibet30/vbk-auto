import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { mergedDailyRouteSources } from "../../src/main/agent/daily-route-source.js";
import {
  dailyRouteStructureProblem,
  routeFingerprint,
  structuredAlternativeGroups,
  type DailyRouteStructure,
} from "../../src/main/planning/daily-route-structure.js";
import { explicitAlternativeGroups } from "../../src/main/planning/itinerary-input-contract/alternative.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

const IDEA = "D1：长沙 → 韶山（二选一：毛泽东故居、滴水洞）\nD2：岳阳楼 或 君山岛";
const DAYS: DailyRouteStructure["days"] = [
  { day: 1, nodes: [
    { name: "长沙", kind: "place" }, { name: "韶山", kind: "place" },
    { name: "毛泽东故居", kind: "attraction", relation: "or" },
    { name: "滴水洞", kind: "attraction", relation: "or" },
  ] },
  { day: 2, nodes: [{ name: "岳阳楼", kind: "attraction" }, { name: "君山岛", kind: "attraction" }] },
];

function draft(userIdea: string): ProductDetail {
  const product = buildProductSnapshot({ destination: "长沙", days: 2, productForm: "freeTravel" });
  Object.assign(product.product.basicInfo!, {
    days: 2, nights: 1, meetingCity: "长沙", destinationCity: "长沙", province: "湖南", userIdea,
  });
  product.product.itinerary = [];
  return product;
}

test("全部天都没有节点时不能当成已读懂的原路线", () => {
  const sources = mergedDailyRouteSources(IDEA);
  assert.match(dailyRouteStructureProblem(sources, [{ day: 1, nodes: [] }, { day: 2, nodes: [] }]) ?? "",
    /没有给出任何路线节点/);
  // 个别天没有节点是合法的（纯接送/返程日）：只要有一天读到节点就采纳。
  assert.equal(dailyRouteStructureProblem(sources, DAYS), undefined);
  assert.equal(dailyRouteStructureProblem(sources, [{ day: 1, nodes: DAYS[0]!.nodes }, { day: 2, nodes: [] }]), undefined);
});

test("「（二选一：A、B）」写在候选之前也认，服务说明里的「或」不冒充选择标记", () => {
  const headMarker = mergedDailyRouteSources("D1：长沙 → 韶山（二选一：毛泽东故居、滴水洞）");
  assert.equal(dailyRouteStructureProblem(headMarker, [{
    day: 1, nodes: [
      { name: "长沙", kind: "place" }, { name: "韶山", kind: "place" },
      { name: "毛泽东故居", kind: "attraction", relation: "or" },
      { name: "滴水洞", kind: "attraction", relation: "or" },
    ],
  }]), undefined);

  const serviceText = mergedDailyRouteSources("D1：长沙 — 韶山（含接送或自理）— 滴水洞");
  assert.match(dailyRouteStructureProblem(serviceText, [{
    day: 1, nodes: [
      { name: "长沙", kind: "place" },
      { name: "韶山", kind: "attraction", relation: "or" },
      { name: "滴水洞", kind: "attraction", relation: "or" },
    ],
  }]) ?? "", /附近原文没有选择标记/);
});

test("AI 只标了部分天的二选一时，其余天仍用文本规则兜底，不能整组丢失", () => {
  const source = mergedDailyRouteSources(IDEA);
  const product = draft(IDEA);
  product.product.diagnostics = { dailyRouteStructure: { version: 2, fingerprint: routeFingerprint(source), days: DAYS } };
  // AI 结构里只标了 D1；D2 的「岳阳楼 或 君山岛」必须仍被识别。
  assert.deepEqual(structuredAlternativeGroups(product.product), [{ day: 1, names: ["毛泽东故居", "滴水洞"] }]);
  assert.deepEqual(explicitAlternativeGroups(product), [
    { day: 1, names: ["毛泽东故居", "滴水洞"] },
    { day: 2, names: ["岳阳楼", "君山岛"] },
  ]);
});
