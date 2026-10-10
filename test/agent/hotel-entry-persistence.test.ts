import test from "node:test";
import assert from "node:assert/strict";
import { createItineraryHotelTool } from "../../src/main/agent/integration-itinerary-hotel-tool.js";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import type { AgentBusinessDependencies } from "../../src/main/agent/integration-generate.js";

const candidate = { hotelId: 122756354, hotelName: "隐筑花涧庭院民宿", diamond: 3, ratingType: "homestay", score: 4.8, cityName: "留坝", anchorCityId: 21367, anchorName: "留侯古镇", distanceKm: 1.24 };

function fixture(instruction: string) {
  let saved = buildProductSnapshot({ destination: "西安", days: 6, productForm: "privateTour" });
  saved.product = { ...saved.product, basicInfo: { ...saved.product.basicInfo, userIdea: "3-留侯住宿", nights: 5, operationNotes: "全程当地5钻酒店；按行程接送站" },
    operations: { hotelTier: "当地5钻酒店" }, itinerary: [{ day: 3, hotel: candidate.hotelName, hotelRequirement: { anchorName: "留侯", cityName: "留坝", diamond: 5, ratingType: "diamond", maxDistanceKm: 5 }, spots: [], hotelCandidates: [candidate] }] } as typeof saved.product;
  const store = { getProduct: () => saved, updateProduct: (_id: string, product: Record<string, unknown>) => { saved = { ...saved, product: product as typeof saved.product }; } };
  const service = new ProductMutationService(store);
  const deps = { db: { ...store, listProducts: () => [], getAgentSnapshot: () => ({ events: [{ type: "user", content: instruction }] }) }, productMutations: service } as unknown as AgentBusinessDependencies;
  return { tool: createItineraryHotelTool(deps, () => saved), service, get: () => saved };
}

test("真实酒店工具恢复逐日回答，经统一保存同步文案并保持锁定接团城市", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("已有核验候选不得再次请求"); };
  try {
    const f = fixture('{"hotel3":["接受三圆钻民宿，保留留侯"]}\n允许迭代降低钻级');
    const current = f.get();
    const receipt = await f.tool.execute({}, { localProductId: current.id, accountKey: "test", productVersion: "test" });
    assert.equal(JSON.parse(receipt.content).persisted, true);
    const saved = f.get().product as any;
    assert.equal(saved.basicInfo.meetingCity, "西安");
    assert.equal(saved.basicInfo.destinationCity, "西安");
    assert.equal(saved.itinerary[0].hotelRequirement.ratingType, "homestay");
    assert.equal(saved.operations.hotelFallbackPolicy.allowDowngrade, true);
    assert.match(saved.basicInfo.operationNotes, /3民宿圆钻/);
    assert.doesNotMatch(saved.basicInfo.operationNotes, /全程当地5钻/);
  } finally { globalThis.fetch = originalFetch; }
});

test("无关整包保存不能重新引入与实际住宿冲突的宣传", () => {
  const f = fixture("");
  const current = f.get();
  current.product.itinerary![0]!.hotelRequirement = { anchorName: "留侯", cityName: "留坝", diamond: 3, ratingType: "homestay", maxDistanceKm: 5 };
  f.service.replace(current.id, current.product);
  assert.doesNotMatch(String((f.get().product.basicInfo as any).operationNotes), /全程当地5钻/);
  const replay = structuredClone(f.get().product) as any;
  replay.basicInfo.operationNotes = "全程当地5钻酒店；按行程接送站";
  f.service.replace(current.id, replay);
  assert.doesNotMatch(String((f.get().product.basicInfo as any).operationNotes), /全程当地5钻/);
});
