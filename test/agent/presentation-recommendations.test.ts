import assert from "node:assert/strict";
import test from "node:test";
import { hasCompletePresentationRecommendations } from "../../src/main/agent/integration.js";

test("recommendation completion requires exactly three populated, distinct categories", () => {
  assert.equal(hasCompletePresentationRecommendations({
    recommendations: [
      { category: "服务保障", text: "全程专车衔接酒店与宽窄巷子，避开自行换乘的繁琐，2天出行更安心" },
      { category: "精选酒店", text: "1晚当地高品质住宿，位置与卫生双重把关，整体休息体验更舒适安心" },
      { category: "特色美食", text: "沿途安排本地老店特色小吃与简餐，餐食与景点结合，体验更丰富" },
    ],
  }), true);
  assert.equal(hasCompletePresentationRecommendations({
    recommendations: [
      { category: "服务保障", text: "全程专车衔接酒店与宽窄巷子，避开自行换乘的繁琐，2天出行更安心" },
      { category: "服务保障", text: "当地资深讲解全程随行，古建与典故介绍详细，整体体验更深入" },
      { category: "特色美食", text: "沿途安排本地老店特色小吃与简餐，餐食与景点结合，体验更丰富" },
    ],
  }), false);
  assert.equal(hasCompletePresentationRecommendations({
    recommendations: [
      { category: "服务保障", text: "全程专车衔接酒店与宽窄巷子，避开自行换乘的繁琐，2天出行更安心" },
      { category: "精选酒店", text: "1晚当地高品质住宿，位置与卫生双重把关，整体休息体验更舒适安心" },
    ],
  }), false);
});
