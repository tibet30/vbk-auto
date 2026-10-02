import assert from "node:assert/strict";
import test from "node:test";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import { DbOrchestratorRuntime } from "../../src/main/planning/runtime.js";

const USER_IDEA = `D1: 潮汕接团 > 自由活动
D2: 南澳大桥 > 长山尾灯塔 > 彩虹公路 > 三囱崖灯塔 > 无人机航拍 > 青澳湾 > 北回归线 > 2 号公路 > 彩虹海 > 孤独榕树村
D3: 炮台公园 > 英歌小镇 > 菩提禅寺 > 潮汕历史文化博览中心 > 小公园 > 南生百货 > 汕头邮政总局 > 镇邦美食街
D4: 龙湖古寨 > 韩文公祠 > 潮人公园 > 潮州古城 > 广济桥（不上桥） > 牌坊街 > 甲第巷 > 开元寺
D5: 潮汕送团`;

function itinerary() {
  const days = [
    ["潮汕接团", "自由活动"],
    ["南澳大桥", "长山尾灯塔", "彩虹公路", "三囱崖灯塔", "无人机航拍", "青澳湾", "北回归线", "2 号公路", "彩虹海", "孤独榕树村"],
    ["炮台公园", "英歌小镇", "菩提禅寺", "潮汕历史文化博览中心", "小公园", "南生百货", "汕头邮政总局", "镇邦美食街"],
    ["龙湖古寨", "韩文公祠", "潮人公园", "潮州古城", "广济桥", "牌坊街", "甲第巷", "开元寺"],
    ["潮汕送团"],
  ];
  return days.map((spots, index) => ({
    day: index + 1,
    title: `第${index + 1}天`,
    spots: spots.map((name) => ({ name, poiName: null, poiId: null })),
    description: `第${index + 1}天行程`,
    hotel: "当地5钻酒店",
    meals: "自理",
  }));
}

test("真实 runtime 写入保留完整用户行程，并继续拒绝重排", async () => {
  const detail = buildProductSnapshot({ destination: "潮州", days: 5, productForm: "groupTour", userIdea: USER_IDEA });
  let saved = detail.product;
  const db = {
    getProduct: () => ({ ...detail, product: saved }),
    getSetting: () => null,
    updateProduct: (_id: string, product: Record<string, unknown>) => {
      saved = structuredClone(product);
    },
  };
  const runtime = new DbOrchestratorRuntime(db as any, undefined, new ProductMutationService(db as any));

  assert.deepEqual(await runtime.writeModule(detail.id, "itinerary", "/itinerary", itinerary()), { ok: true });
  const persisted = saved.itinerary as Array<{ spots: unknown[] }>;
  assert.deepEqual(persisted.map((day) => day.spots.length), [2, 10, 8, 8, 1]);
  assert.deepEqual((persisted[1]?.spots[1] as { name: string }).name, "长山尾灯塔");
  assert.deepEqual((persisted[3]?.spots[7] as { name: string }).name, "开元寺");

  const verified = saved.itinerary as Array<{ spots: Array<Record<string, unknown>> }>;
  Object.assign(verified[1]!.spots[0]!, { poiName: "南澳大桥", poiId: 10546075, city: "汕头" });
  const genericRegeneration = itinerary();
  assert.deepEqual(await runtime.writeModule(detail.id, "itinerary", "/itinerary", genericRegeneration), { ok: true });
  const readback = saved.itinerary as Array<{ spots: Array<Record<string, unknown>> }>;
  assert.deepEqual(readback[1]?.spots[0], {
    name: "南澳大桥", kind: "attraction", poiName: "南澳大桥", poiId: 10546075, city: "汕头",
  });

  const reordered = itinerary();
  [reordered[1]!.spots[0], reordered[1]!.spots[1]] = [reordered[1]!.spots[1]!, reordered[1]!.spots[0]!];
  const rejected = await runtime.writeModule(detail.id, "itinerary", "/itinerary", reordered);
  assert.match(rejected.reason ?? "", /完整|重排|替换/);
  assert.deepEqual((saved.itinerary as Array<{ spots: unknown[] }>).map((day) => day.spots.length), [2, 10, 8, 8, 1]);
});
