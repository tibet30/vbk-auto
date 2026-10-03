import test from "node:test";
import assert from "node:assert/strict";
import { isExteriorOnlyVisit } from "../../src/main/automation/ctrip/itinerary-api/visit-semantics.js";
import { attractionTicketSuffix } from "../../src/main/automation/ctrip/itinerary-api/info-builders.js";
import { buildAdultTicketInclusionText } from "../../src/main/automation/ctrip/terms.js";
test("真实重跑的“不安排上桥通行”同时约束行程外观与门票条款", () => {
  const spot = { name: "广济桥", poiName: "广济桥", ticketType: { key: 1 }, description: "参观广济桥外观与桥亭结构，远眺十八梭船启闭式浮桥，不安排上桥通行。" };
  assert.equal(isExteriorOnlyVisit(spot.description), true);
  assert.deepEqual(attractionTicketSuffix(spot), { key: 1, name: "外观" });
  assert.equal(buildAdultTicketInclusionText([{ spots: [spot] }]), "");
});
test("未限制上桥或明确允许入内时不取消门票", () => {
  for (const text of ["安排上桥通行。", "不安排上桥后，改为入内参观。", "并非不上桥，可上桥参观。", "参观广济桥外观与桥亭结构。"])
    assert.equal(isExteriorOnlyVisit(text), false);
});
