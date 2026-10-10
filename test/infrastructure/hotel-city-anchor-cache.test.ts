import assert from "node:assert/strict";
import test from "node:test";
import { reusableHotelCandidates, reusableHotelCandidatesFromPool } from "../../src/main/infrastructure/ctrip-hotel-candidate-cache.js";
import { selectCtripHotelContext } from "../../src/main/infrastructure/ctrip-hotel-search.js";

test("无坐标城市候选优先同名市政府，不选同名前缀景区", () => {
  const base = { cityId: 129, cityName: "汉中", type: "Markland", gLat: 33.06, gLon: 107.02 };
  const selected = selectCtripHotelContext([
    { ...base, id: "scenic", word: "汉中龙头山国际旅游度假区" },
    { ...base, id: "center", word: "汉中市人民政府" },
  ], { anchorName: "汉中", preferredCity: "汉中", requirePreferredCity: true });
  assert.equal(selected.id, "center");
});

test("市区住宿重新核验旧景区距离，而不丢失酒店选择", () => {
  const hotel = { hotelId: 115803952, hotelName: "汉中北岸云憬酒店", diamond: 5, score: 4.8,
    distanceKm: 33.53, cityName: "汉中", anchorName: "汉中龙头山国际旅游度假区", anchorCityId: 129 };
  const requirement = { anchorName: "汉中", cityName: "汉中", diamond: 5 };
  assert.equal(reusableHotelCandidates({ hotel: hotel.hotelName, hotelCandidates: [hotel] }, "当地5钻酒店", requirement), undefined);
  assert.equal(reusableHotelCandidatesFromPool([hotel], "当地5钻酒店", requirement), undefined);
  const current = { ...hotel, anchorName: "汉中市人民政府", distanceKm: 2.1 };
  assert.deepEqual(reusableHotelCandidates({ hotel: hotel.hotelName, hotelCandidates: [current] }, "当地5钻酒店", requirement), [current]);
  assert.deepEqual(reusableHotelCandidatesFromPool([current], "当地5钻酒店", requirement), [current]);
});
