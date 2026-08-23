import test from "node:test";
import assert from "node:assert/strict";
import {
  hasBorderPermitItineraryTrigger,
  hasResolvedBorderPermitVisibleFields,
  itineraryDayHasBorderPermitTrigger,
} from "../../src/shared/border-permit.js";

test("边防证触发只看当前行程，不被旧 userIdea / 推荐文案拖住", () => {
  const product = {
    basicInfo: { userIdea: "旧路线：亚东、乃堆拉国门" },
    presentation: { recommendation: "行程涉及边境通行" },
    itinerary: [
      { day: 1, title: "日喀则市区朝圣文化一日游", spots: [{ name: "扎什伦布寺" }] },
      { day: 2, title: "江孜古堡与冰川奇景全日游", spots: [{ name: "白居寺" }] },
    ],
  };

  assert.equal(hasBorderPermitItineraryTrigger(product), false);
});

test("含乃堆拉 / 国门 / 珠峰的行程日会触发证件提示", () => {
  assert.equal(itineraryDayHasBorderPermitTrigger({
    day: 2,
    title: "亚东深度游",
    spots: [{ name: "乃堆拉国门" }],
  }), true);
  assert.equal(itineraryDayHasBorderPermitTrigger({
    day: 1,
    title: "珠峰小镇入住",
    description: "前往珠峰方向观景",
  }), true);
});

test("边防证口径只从基础运营备注或每日行程描述判断是否落地", () => {
  assert.equal(hasResolvedBorderPermitVisibleFields({
    itinerary: [{ day: 1, title: "乃堆拉国门", description: "出行人须提前办理边境地区通行证，并携带有效身份证件。" }],
  }), true);
  assert.equal(hasResolvedBorderPermitVisibleFields({
    basicInfo: { operationNotes: "本线路须提前办理边防证，并携带有效身份证件。" },
    itinerary: [{ day: 1, title: "珠峰方向" }],
  }), true);
  assert.equal(hasResolvedBorderPermitVisibleFields({
    commercial: { terms: { bookingNotes: "出行人须提前办理边境地区通行证，并携带有效身份证件。" } },
    itinerary: [{ day: 1, title: "乃堆拉国门" }],
  }), false);
});
