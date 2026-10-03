import assert from "node:assert/strict";
import test from "node:test";
import { unchangedResourceSegments } from "../../src/main/automation/ctrip/resource-segment-readback.js";

const segment = {
  segmentId: "old", productId: 79233672,
  segmentBase: { segmentNumber: 2, stayNights: 2, destinationCity: { cityId: 447, cityName: "汕头" } },
  hotel: { segmentRooms: [{ masterHotelID: 694781, squenceNumber: 5 }] },
  packages: [{ packageId: 1 }], segmentResourceGroups: [{ resourceGroupId: 2 }],
};
const payload = (value: unknown) => ({ draftProductSegments: { segments: [value] } });

test("missing-draft recovery accepts existing hotels only when all content survives", () => {
  assert.equal(unchangedResourceSegments(payload(segment), payload({ ...segment, segmentId: "new" })), true);
  for (const change of [
    { hotel: { segmentRooms: [] } },
    { hotel: { segmentRooms: [...segment.hotel.segmentRooms, { masterHotelID: 123, squenceNumber: 4 }] } },
    { segmentBase: { ...segment.segmentBase, stayNights: 1 } },
    { packages: [] }, { segmentResourceGroups: [] },
  ]) {
    assert.equal(unchangedResourceSegments(payload(segment), payload({ ...segment, ...change })), false);
  }
  assert.equal(unchangedResourceSegments({}, {}), false);
});

test("草稿更换临时产品与段 ID 时，只接受同步重映射的自身引用", () => {
  const before = { ...segment, packages: [{ packageId: 1, segmentId: 'old', productId: 79233672 }] };
  const after = { ...before, segmentId: 'draft', productId: 2135334353,
    packages: [{ packageId: 1, segmentId: 'draft', productId: 2135334353 }] };
  assert.equal(unchangedResourceSegments(payload(before), payload(after)), true);
  assert.equal(unchangedResourceSegments(payload(before), payload({ ...after,
    packages: [{ packageId: 1, segmentId: 'unrelated', productId: 2135334353 }] })), false);
  assert.equal(unchangedResourceSegments(payload(before), payload({ ...after,
    packages: [{ packageId: 2, segmentId: 'draft', productId: 2135334353 }] })), false);
});
