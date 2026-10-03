import test from "node:test";
import assert from "node:assert/strict";
import { materializeRetainedItinerary } from "../../src/main/automation/automation.main/itinerary-retained-text.js";
import { requiresItineraryPoi } from "../../src/shared/itinerary-activity-kind.js";
const product = () => ({ itinerary: [{ spots: [{ name: "开元寺", kind: "attraction", poiId: null, poiName: null, description: "游览寺院" }] }] });
const task = { state: "confirmed", type: "vbk", label: "核查 开元寺 的 VBK POI 映射", detail: "已保留原景点和原行程位置" };
test("已接受文字保留的准备状态落实到自动录入，保留顺序和说明", () => {
  const original = product(); const result = materializeRetainedItinerary(original, [task]);
  assert.equal(result.changed, true);
  const spot = (result.product.itinerary as any[])[0].spots[0];
  assert.equal(requiresItineraryPoi(spot), false);
  assert.equal(spot.description, "游览寺院");
  assert.equal(spot.poiId, null);
  assert.equal(requiresItineraryPoi(original.itinerary[0].spots[0]), true);
  assert.equal(materializeRetainedItinerary(result.product, [task]).changed, false);
});
test("未确认、其他景点及已验证 POI 均不被文字保留覆盖", () => {
  assert.equal(materializeRetainedItinerary(product(), [{ ...task, state: "pending" }]).changed, false);
  assert.equal(materializeRetainedItinerary(product(), [{ ...task, label: "核查 牌坊街 的 VBK POI 映射" }]).changed, false);
  const verified = product(); Object.assign(verified.itinerary[0].spots[0], { poiId: 85864, poiName: "开元寺" });
  assert.equal(materializeRetainedItinerary(verified, [task]).changed, false);
});
