import test from "node:test";
import assert from "node:assert/strict";
import { privateTourSubtitle, tourTitleSpots, vbkCopyWidth } from "../../src/shared/private-tour-copy.js";
import { HOTEL_SELECTION_NOTE } from "../../src/shared/itinerary-service-copy.js";
import { requiredTourImagePois, missingTourImagePois } from "../../src/shared/tour-image-coverage.js";
import { applyAutoCoverFill } from "../../src/main/operations/cover-auto-fill.js";
import { presentationFallback } from "../../src/main/planning/presentation-fallback.js";
import { checkServiceCards } from "../../src/main/automation/ctrip/itinerary-api/readback-service-cards.js";
import { projectDraftWrite } from "../../src/main/automation/ctrip/itinerary-api/draft-write-projection.js";

const spots = [
  { name: "免费街区", poiId: 1, ticketType: { key: 2 } },
  { name: "门票景点甲", poiId: 2, ticketType: { key: 1 } },
  { name: "门票景点乙", poiId: 3, ticketType: { key: 1 } },
  { name: "外观景点", poiId: 4, ticketType: { key: 1 }, description: "仅外观，不入内" },
];

test("主标题跨日优先收费景点，去重且排除仅外观游览", () => {
  assert.deepEqual(tourTitleSpots([...spots, spots[1]!]).map(spot => spot.name), ["门票景点甲", "门票景点乙"]);
  assert.deepEqual(tourTitleSpots([spots[0]!]).map(spot => spot.name), ["免费街区"]);
});

test("副标题保留固定服务，不重复主标题景点，满足平台字数", () => {
  const value = privateTourSubtitle("门票景点甲+门票景点乙2天1晚私家团｜古建与民俗体验串联", ["门票景点甲", "门票景点乙"]);
  assert.match(value, /^一单一团\+24h线上管家/);
  assert.doesNotMatch(value, /门票景点|2天|1晚|私家团/);
  assert.match(value, /古建与民俗/);
  for (const input of ["", "成都", "文化探索".repeat(50)]) {
    const width = vbkCopyWidth(privateTourSubtitle(input));
    assert.ok(width >= 30 && width <= 80);
  }
});

function galleryProduct(spots: Array<Record<string, unknown>>, cover?: Record<string, unknown>) {
  return { sales: { productForm: "privateTour" }, basicInfo: { meetingCity: "太原" }, itinerary: [{ day: 1, title: "文化探索", spots }],
    presentation: { cover: cover ?? { source: "ctripLibrary", poi: "景点甲", description: "封面", minQuality: 3 } } };
}
function candidate(poiId: number, poiName: string) {
  return { stableId: String(poiId), index: 0, imageId: 100 + poiId, imageUrl: `https://example.test/${poiId}.jpg`,
    poiId, poiName, imageResolved: true, quality: "4", resolution: "1920*1080", score: 4 };
}
const page = {} as any;

test("十张图来自同一景点时继续找图，保留主图并覆盖遗漏景点", async () => {
  const cover = { source: "ctripLibrary", poi: "景点甲", poiId: 1, imageId: 1, imageUrl: "https://example.test/1.jpg",
    alternates: Array.from({ length: 9 }, (_, i) => ({ poi: "景点甲", poiId: 1, imageId: i + 2, imageUrl: `https://example.test/${i + 2}.jpg` })) };
  const product = galleryProduct([{ name: "景点甲", poiId: 1 }, { name: "景点乙", poiId: 2 }], cover);
  const { nextProduct } = await applyAutoCoverFill({ page, product, injectSearch: async (_page, keyword) => ({ keyword, candidates: [candidate(keyword === "景点乙" ? 2 : 1, keyword)] }) });
  const result = (nextProduct.presentation as any).cover;
  assert.equal(result.imageId, 1);
  assert.ok(result.alternates.some((image: any) => image.poiId === 2));
  assert.deepEqual(result.missingPoiImages, []);
  assert.equal([result, ...result.alternates].length, 10);
});

test("超过十个收费景点时逐个覆盖，不受旧十张上限截断", async () => {
  const spots = Array.from({ length: 12 }, (_, i) => ({ name: `景点${i + 1}`, poiId: i + 1, ticketType: { key: 1 } }));
  const product = galleryProduct(spots);
  const { nextProduct } = await applyAutoCoverFill({ page, product, injectSearch: async (_page, keyword) => ({ keyword, candidates: [candidate(Number(keyword.slice(2)), keyword)] }) });
  const result = (nextProduct.presentation as any).cover;
  assert.equal([result, ...result.alternates].length, 12);
  assert.deepEqual(missingTourImagePois(product, [result, ...result.alternates]), []);
});

test("图库没有某景点时保留待补清单，不挪用另一景点照片", async () => {
  const product = galleryProduct([{ name: "景点甲", poiId: 1 }, { name: "景点乙", poiId: 2 }]);
  const { nextProduct } = await applyAutoCoverFill({ page, product, injectSearch: async (_page, keyword) => ({ keyword, candidates: keyword === "景点甲" ? [candidate(1, keyword)] : [] }) });
  assert.deepEqual((nextProduct.presentation as any).cover.missingPoiImages, ["景点乙"]);
  assert.deepEqual(requiredTourImagePois(galleryProduct(spots)).map(poi => poi.name), ["门票景点甲", "门票景点乙", "外观景点"]);
});

test("交通与酒店卡片回读拒绝丢失、错时、错位及不完整选房说明", () => {
  const expected = { transport: { description: "第2天，全天用车" }, hotels: [{ selectionNote: HOTEL_SELECTION_NOTE }] } as any;
  const infos = [
    { activeType: { key: 0 }, tourDailyDinner: { dinnerType: { key: "B" } } },
    { activeType: { key: 8 }, takeoffTime: { key: "D" }, description: "第2天，全天用车" },
    { activeType: { key: 1 }, description: `酒店甲\n${HOTEL_SELECTION_NOTE}` },
  ];
  checkServiceCards("第2天", expected, infos);
  assert.throws(() => checkServiceCards("第2天", expected, [infos[0]!, infos[2]!]), /交通卡片数量/);
  assert.throws(() => checkServiceCards("第2天", expected, [infos[1]!, infos[0]!, infos[2]!]), /紧接早餐/);
  assert.throws(() => checkServiceCards("第2天", expected, [infos[0]!, { ...infos[1], takeoffTime: { key: "A" } }, infos[2]!]), /全天时间/);
  assert.throws(() => checkServiceCards("第2天", expected, [infos[0]!, infos[1]!, { activeType: { key: 1 }, description: "酒店甲" }]), /完整选房说明/);
  assert.deepEqual(projectDraftWrite([{ tourDailyInfos: infos }]).transportNodes, [{ day: 1, position: 1, time: "D", description: "第2天，全天用车" }]);
});

test("兜底图文取实际日程特色，不虚构含餐、导游或酒店权益", () => {
  const copy = presentationFallback({ sales: { productForm: "privateTour" }, basicInfo: { meetingCity: "太原", days: 1 }, operations: { transport: "charter" },
    itinerary: [{ day: 1, title: "古建探访", description: "游览晋祠，观察木构与壁画", spots: [{ name: "晋祠" }] }] });
  assert.match(copy.features, /木构与壁画/);
  assert.match(copy.features, /一单一团\+24h线上管家/);
  assert.doesNotMatch(copy.features, /赠送|专业导游|豪华酒店/);
  assert.equal((copy.features.match(/<p>/g) ?? []).length, 3);
  assert.equal(new Set(copy.recommendations.map(reason => reason.text)).size, 3);
  assert.ok(copy.recommendations.every(reason => vbkCopyWidth(reason.text) >= 30 && vbkCopyWidth(reason.text) <= 84));
});


test("二十个收费景点时容量全部用于景点覆盖，免费旧自动封面不占名额", async () => {
  const spots = [{ name: "免费景点", poiId: 99, ticketType: { key: 2 } }, ...Array.from({ length: 20 }, (_, i) => ({ name: `景点${i + 1}`, poiId: i + 1, ticketType: { key: 1 } }))];
  const product = galleryProduct(spots, { source: "ctripLibrary", poi: "免费景点", poiId: 99, imageId: 99, imageUrl: "https://example.test/free.jpg" });
  const { nextProduct } = await applyAutoCoverFill({ page, product, injectSearch: async (_page, keyword) => ({ keyword, candidates: keyword.startsWith("景点") ? [candidate(Number(keyword.slice(2)), keyword)] : [] }) });
  const result = (nextProduct.presentation as any).cover;
  assert.equal([result, ...result.alternates].length, 20);
  assert.deepEqual(result.missingPoiImages, []);
  assert.notEqual(result.imageId, 99);
});
