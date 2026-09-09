import assert from "node:assert/strict";
import test from "node:test";
import { createAgentBusinessTools, selectItinerarySpot } from "../../src/main/agent/integration.js";

const product = {
  product: {
    itinerary: [{
      day: 2,
      spots: [
        { name: "日喀则非物质文化遗产展示中心", poiName: null, poiId: null },
        { name: "扎什伦布寺", poiName: null, poiId: null },
      ],
    }],
  },
} as any;

test("selectItinerarySpot only accepts a unique city-prefix alias", () => {
  const selected = selectItinerarySpot(product, 2, "非物质文化遗产展示中心");
  assert.equal(selected.dayIndex, 0);
  assert.equal(selected.spotIndex, 0);
});

test("selectItinerarySpot rejects an ambiguous short alias", () => {
  const ambiguous = {
    product: {
      itinerary: [{
        day: 2,
        spots: [
          { name: "日喀则博物馆", poiName: null },
          { name: "江孜博物馆", poiName: null },
        ],
      }],
    },
  } as any;
  assert.throws(() => selectItinerarySpot(ambiguous, 2, "博物馆"), /存在多个/);
});

test("agent itinerary patch schema accepts the persisted and relation", () => {
  const tools = createAgentBusinessTools({} as any);
  const patchTool = tools.find((tool) => tool.name === "patch_product")!;
  const schema = patchTool.parameters as any;
  assert.deepEqual(schema.properties.patch.properties.itinerary.items.properties.spots.items.properties.relation.enum, ["and", "or"]);
});

test("agent exposes a local-only traffic availability recheck", () => {
  const tools = createAgentBusinessTools({} as any);
  const tool = tools.find((item) => item.name === "recheck_traffic_line_availability")!;

  assert.equal(tool.write, true);
  assert.equal(tool.requiresApproval, false);
  assert.match(tool.description, /不会创建、保存或写入任何 VBK 交通子产品/);
});
