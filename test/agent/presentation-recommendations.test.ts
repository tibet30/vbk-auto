import assert from "node:assert/strict";
import test from "node:test";
import { hasCompletePresentationRecommendations } from "../../src/main/agent/integration.js";

test("recommendation completion requires exactly three populated, distinct categories", () => {
  assert.equal(hasCompletePresentationRecommendations({
    recommendations: [
      { category: "服务保障", text: "专车接送" },
      { category: "精选酒店", text: "当地四钻住宿" },
      { category: "特色美食", text: "沿线简餐" },
    ],
  }), true);
  assert.equal(hasCompletePresentationRecommendations({
    recommendations: [
      { category: "服务保障", text: "专车接送" },
      { category: "服务保障", text: "当地讲解" },
      { category: "特色美食", text: "沿线简餐" },
    ],
  }), false);
  assert.equal(hasCompletePresentationRecommendations({
    recommendations: [
      { category: "服务保障", text: "专车接送" },
      { category: "精选酒店", text: "当地四钻住宿" },
    ],
  }), false);
});
