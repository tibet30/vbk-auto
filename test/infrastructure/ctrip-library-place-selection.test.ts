import assert from "node:assert/strict";
import test from "node:test";
import { selectAutomaticLibraryPlace } from "../../src/main/infrastructure/ctrip-library-place-selection.js";

test("exact 尧坝古镇 wins over earlier unrelated popular ancient towns", () => {
  const places = ["南浔古镇", "青岩古镇", "西塘古镇", "尧坝古镇", "尧坝古镇-慈云寺"]
    .map((poiName, index) => ({ poiId: index + 1, poiName } as any));
  assert.equal(selectAutomaticLibraryPlace(places, "尧坝古镇").poiId, 4);
  assert.equal(selectAutomaticLibraryPlace(places, "未知关键字").poiId, 1);
  assert.throws(() => selectAutomaticLibraryPlace([...places, { ...places[3]!, poiId: 9 }], "尧坝古镇"), /多个同名/);
});
