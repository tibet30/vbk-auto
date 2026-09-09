import assert from "node:assert/strict";
import test from "node:test";
import { clearUnverifiedItineraryPois } from "../../src/main/agent/integration.js";

test("clearUnverifiedItineraryPois 不因 undefined/null/字符串景点崩溃", () => {
  const itinerary = [
    {
      day: 1,
      spots: [
        undefined,
        null,
        "宽窄巷子",
        { name: "武侯祠", poiName: "武侯祠", poiId: 456 },
        "   ",
      ],
    },
  ];

  assert.doesNotThrow(() => clearUnverifiedItineraryPois(itinerary));
  assert.deepEqual(itinerary[0]?.spots, [
    { name: "宽窄巷子", poiName: null, poiId: null },
    { name: "武侯祠", poiName: null, poiId: null },
  ]);
});

test("clearUnverifiedItineraryPois 忽略非数组行程", () => {
  assert.doesNotThrow(() => clearUnverifiedItineraryPois({ item: [] }));
  assert.doesNotThrow(() => clearUnverifiedItineraryPois(null));
});
