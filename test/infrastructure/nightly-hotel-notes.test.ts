import test from "node:test";
import assert from "node:assert/strict";
import { hotelStayRequirement } from "../../src/shared/hotel-stay-requirement.js";

const product = { basicInfo: { userIdea: "**10 月 6 号 D3：** 水上雅丹-俄博梁（俄博梁星空）\n**10 月 7 号 D4：** 俄博梁-冷湖\n已确认的住宿要求：第3晚优先俄博梁附近营地或民宿，接受较低档次；第4晚住冷湖镇。第3晚可使用2圆钻营地或民宿。" } };
const spots = [{ name: "俄博梁", poiName: "俄博梁", poiId: 123, city: "海西", district: "茫崖" }];
test("日期路线后的每晚住宿说明成为精确锚点，圆钻类型和等级不丢失", () => {
  assert.deepEqual(hotelStayRequirement(product, { day: 3, hotel: "俄博梁附近营地或民宿", spots }),
    { anchorName: "俄博梁", cityName: "茫崖", maxDistanceKm: 5, diamond: 2, ratingType: "homestay" });
  assert.deepEqual(hotelStayRequirement(product, { day: 4, hotel: "冷湖镇", spots: [{ ...spots[0], name: "冷湖", poiName: "冷湖" }] }),
    { anchorName: "冷湖镇", cityName: "茫崖", maxDistanceKm: 5 });
  assert.equal(hotelStayRequirement(product, { day: 6, hotel: "无", spots }), undefined);
});
test("已保存的住宿决策仍优先于初始每晚说明，不被重新扩大或缩小边界", () => {
  const stored = { anchorName: "茫崖市区", cityName: "茫崖", diamond: 4, ratingType: "diamond" };
  assert.deepEqual(hotelStayRequirement(product, { day: 3, hotelRequirement: stored, spots }), stored);
});
