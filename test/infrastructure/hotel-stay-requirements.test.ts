import test from "node:test";
import assert from "node:assert/strict";
import { hotelStayRequirement } from "../../src/shared/hotel-stay-requirement.js";

/**
 * 住宿要求只负责「当晚住哪」：住宿地锚点与行政城市。
 * 逐晚钻级、民宿/星级、距离上限不再从原文推导；历史产品已保存的值仍原样回读。
 */
test("住宿字段缺少行政区时，使用住宿前最近的行政地点而不是旧城市", () => {
  const product = {
    basicInfo: {
      userIdea: "3-太白县---留坝县美食---张良庙---留侯住宿;\n5-华阳---佛坪---汉中---住汉中",
    },
  };
  assert.equal(hotelStayRequirement(product, {
    day: 3,
    hotel: "留侯镇当地民宿/5钻酒店",
    hotelRequirement: { cityName: "汉中" },
  })?.cityName, "留坝");
  assert.equal(hotelStayRequirement(product, {
    day: 5,
    hotel: "汉中市区当地5钻酒店",
    hotelRequirement: { cityName: "西安" },
  })?.cityName, "汉中");
});

test("逐晚评级不再从原文推导，历史已保存的评级仍原样回读", () => {
  const product = { basicInfo: { userIdea: "第1晚西湖5钻酒店，第2晚古镇3钻民宿" } };
  const day = { day: 2, hotel: "古镇民宿", hotelRequirement: { anchorName: "古镇" } };
  const requirement = hotelStayRequirement(product, day);
  assert.equal(requirement?.anchorName, "古镇");
  assert.equal(requirement?.diamond, undefined, "逐晚钻级不再从用户原文推导");
  assert.equal(requirement?.ratingType, undefined, "民宿/星级不再从用户原文推导");
  assert.equal(requirement?.maxDistanceKm, undefined, "距离限制不再从用户原文推导");
  const latest = { ...day, hotelRequirement: { anchorName: "古镇", diamond: 4, ratingType: "diamond" } };
  assert.equal(hotelStayRequirement(product, latest)?.diamond, 4, "历史产品已保存的评级仍可回读");
  assert.equal(hotelStayRequirement(product, latest)?.ratingType, "diamond");
});

test("单行 D1-D7 路线能逐晚读取括号宿点并换成实际行政城市", () => {
  const product = { basicInfo: { meetingCity: "拉萨", userIdea: [
    "阿里南线7日 D1天：拉萨—羊卓雍措—日喀则（宿日喀则）海拔3800m",
    "D2天：日喀则—珠峰（宿珠峰小镇） D3天：巴松村—萨嘎（宿萨嘎）",
    "D4天：萨嘎—冈仁波齐（宿塔尔钦） D5天：塔钦--札达--塔钦（宿塔尔钦）",
    "D6天：塔钦--仲巴--萨嘎（宿萨嘎） D7天：萨嘎--日喀则--拉萨",
  ].join(" ") } };
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(day => hotelStayRequirement(product, { day })?.cityName),
    ["日喀则", "定日", "萨嘎", "普兰", "普兰", "萨嘎"]);
  assert.equal(hotelStayRequirement(product, { day: 7 }), undefined);
});
