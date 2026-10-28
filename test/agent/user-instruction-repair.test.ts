import assert from "node:assert/strict";
import test from "node:test";
import type { ProductDetail } from "../../src/shared/contracts.js";
import {
  repairProductForExplicitDuration,
  repairProductForExplicitHotelCity,
  repairProductForExplicitInstruction,
} from "../../src/main/agent/user-instruction-repair.js";
import { extractLockedConstraints } from "../../src/main/agent/prompt-helpers.js";
import { itineraryInputContractError, planningWriteContractError } from "../../src/main/planning/itinerary-input-contract.js";
import { agentPatchOperations } from "../../src/main/agent/integration-patch.js";

function detail(): ProductDetail {
  return {
    id: "p1", name: "日喀则2天1晚私家团", status: "draft", updatedAt: "2026-09-10T00:00:00.000Z",
    messages: [], researchTasks: [],
    product: {
      basicInfo: { meetingCity: "日喀则", destinationCity: "日喀则" },
      operations: {
        hotelTier: "当地4钻酒店/-4",
        hotelResource: { resourceId: 1, resourceName: "维也纳酒店(江孜宗山古堡店)" },
      },
      itinerary: [{
        day: 1,
        hotel: "维也纳酒店(江孜宗山古堡店)",
        hotelCandidates: [{ hotelId: 1, hotelName: "维也纳酒店(江孜宗山古堡店)", cityName: "江孜" }],
      }],
    },
  };
}

test("explicit destination lodging correction clears only stale hotel-derived data", () => {
  const current = detail();
  const repaired = repairProductForExplicitHotelCity(
    current,
    "D1明确住日喀则，必须按日喀则作为住宿城市锚点重新匹配酒店候选",
  );
  assert.ok(repaired);
  const day = (repaired.product.itinerary as Array<Record<string, unknown>>)[0]!;
  assert.equal(day.hotel, "日喀则当地4钻酒店");
  assert.equal(day.hotelCandidates, undefined);
  assert.equal((repaired.product.operations as Record<string, unknown>).hotelResource, undefined);
  assert.deepEqual(current.product.itinerary, detail().product.itinerary, "input remains immutable");
});

test("unrelated follow-up leaves prepared hotel candidates intact", () => {
  assert.equal(repairProductForExplicitHotelCity(detail(), "封面换成白居寺"), undefined);
});

test("explicit 4-diamond correction clears a same-city 5-diamond primary", () => {
  const current = detail();
  const day = (current.product.itinerary as Array<Record<string, unknown>>)[0]!;
  day.hotel = "日喀则乔穆朗宗酒店";
  day.hotelCandidates = [{ hotelId: 9, hotelName: "日喀则乔穆朗宗酒店", cityName: "日喀则", diamond: 5 }];
  const repaired = repairProductForExplicitHotelCity(current, "D1明确住日喀则4钻酒店");
  assert.ok(repaired);
  assert.equal((repaired.product.itinerary as Array<Record<string, unknown>>)[0]!.hotelCandidates, undefined);
});

test("explicit duration correction updates days, nights and duration-derived labels", () => {
  const current = detail();
  current.name = "拉萨2天1晚私家团";
  Object.assign(current.product.basicInfo as Record<string, unknown>, {
    days: 2,
    nights: 1,
    supplierProductName: "拉萨2天1晚私家团",
    subtitle: "拉萨2天1晚私家团·经典体验",
  });
  current.product.commercial = { packageName: "拉萨2天1晚私家团" };

  const repaired = repairProductForExplicitDuration(current, "记得是改成4天");
  assert.ok(repaired);
  const basic = repaired.product.basicInfo as Record<string, unknown>;
  assert.equal(basic.days, 4);
  assert.equal(basic.nights, 3);
  assert.equal(basic.supplierProductName, "拉萨4天3晚私家团");
  assert.equal(basic.subtitle, "拉萨4天3晚私家团·经典体验");
  assert.equal((repaired.product.commercial as Record<string, unknown>).packageName, "拉萨4天3晚私家团");
});

test("duration correction accepts only explicit user corrections and accepts Chinese numerals", () => {
  const current = detail();
  Object.assign(current.product.basicInfo as Record<string, unknown>, { days: 2, nights: 1 });
  assert.equal(repairProductForExplicitDuration(current, "四天行程看起来更舒服"), undefined);
  assert.equal(repairProductForExplicitDuration(current, "不要改成四天三晚"), undefined);
  const repaired = repairProductForExplicitDuration(current, "行程改为四天三晚");
  assert.ok(repaired);
  assert.equal((repaired.product.basicInfo as Record<string, unknown>).days, 4);
  assert.equal((repaired.product.basicInfo as Record<string, unknown>).nights, 3);
});

test("remote drafts accept an explicit duration change; only a running automation is protected", () => {
  const remote = detail();
  Object.assign(remote.product.basicInfo as Record<string, unknown>, { days: 2, nights: 1 });
  remote.productId = "123";
  remote.basicInfoSaved = true;
  const repaired = repairProductForExplicitDuration(remote, "改成4天3晚");
  assert.ok(repaired);
  assert.equal((repaired.product.basicInfo as Record<string, unknown>).days, 4);
  assert.equal((repaired.product.basicInfo as Record<string, unknown>).nights, 3);
  // 天数锁跟随 basicInfo：改天数后规划写入按新天数校验，不会被旧天数拒绝。
  const changed = { ...remote, product: repaired.product };
  assert.equal(extractLockedConstraints(changed, []).days, 4);
  const fourDays = [1, 2, 3, 4].map((day) => ({ day, title: `D${day}`, spots: [], description: "游览", hotel: "", meals: "" }));
  assert.doesNotMatch(itineraryInputContractError(changed, fourDays) ?? "", /天数/);
  assert.match(itineraryInputContractError(changed, fourDays.slice(0, 2)) ?? "", /已锁定的 4 天/);
  assert.equal(planningWriteContractError(changed, "skeleton", { days: 4 }), undefined);
  const running = detail();
  running.automation = { id: "run", status: "running", logs: [], phases: [] };
  assert.equal(repairProductForExplicitDuration(running, "改成4天3晚"), undefined);
});

test("combined instruction repair applies duration before hotel correction", () => {
  const current = detail();
  Object.assign(current.product.basicInfo as Record<string, unknown>, { days: 2, nights: 1 });
  const repaired = repairProductForExplicitInstruction(current, "改成4天3晚，并明确住日喀则4钻酒店");
  assert.ok(repaired);
  assert.equal((repaired.product.basicInfo as Record<string, unknown>).days, 4);
});

test("已有 productId 的产品「改成5天4晚」后，三处本地天数锁都跟随为 5 天", () => {
  const remote = detail();
  Object.assign(remote.product.basicInfo as Record<string, unknown>, { days: 2, nights: 1 });
  remote.productId = "79000001";
  remote.basicInfoSaved = true;
  const repaired = repairProductForExplicitDuration(remote, "改成5天4晚");
  assert.ok(repaired);
  const changed = { ...remote, product: repaired.product };
  // prompt-helpers extractLockedConstraints
  assert.equal(extractLockedConstraints(changed, []).days, 5);
  assert.equal(extractLockedConstraints(changed, []).nights, 4);
  // itinerary-input-contract：5 天行程通过，旧 2 天被拒
  const fiveDays = [1, 2, 3, 4, 5].map((day) => ({ day, title: `D${day}`, spots: [], description: "游览", hotel: "", meals: "" }));
  assert.doesNotMatch(itineraryInputContractError(changed, fiveDays) ?? "", /天数/);
  assert.match(itineraryInputContractError(changed, fiveDays.slice(0, 2)) ?? "", /已锁定的 5 天/);
  // integration-patch assertLockedPlanningPatch：锁为 5 天
  assert.doesNotMatch(String((() => { try { agentPatchOperations(changed, { basicInfo: { days: 5, nights: 4 } }); return ""; } catch (error) { return error; } })()), /已锁定/);
  assert.throws(() => agentPatchOperations(changed, { basicInfo: { days: 2, nights: 1 } }), /已锁定为 5 天/);
});
