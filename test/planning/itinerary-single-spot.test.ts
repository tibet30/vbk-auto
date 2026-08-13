import test from "node:test";
import assert from "node:assert/strict";
import { normaliseItinerary } from "../../src/main/data/product-normalize.js";
import { parseStageOutput } from "../../src/main/planning/schemas.js";
import { executeStageOutput } from "../../src/main/planning/stage-runner.js";
import { buildStageToolSchema } from "../../src/main/planning/tool-schema.js";

function itineraryWith(name: string) {
  return [{
    day: 1,
    title: "西安一日",
    spots: [{ name, poiName: null, poiId: null }],
    description: "游览西安核心景点。",
    hotel: "",
    meals: "早餐自理；午餐自理；晚餐自理",
  }];
}

function output(name: string) {
  return {
    reply: "已生成行程。",
    modules: [{ module: "itinerary", status: "accepted", value: itineraryWith(name) }],
  };
}

test("新生成 itinerary 的单一地点 spot 可以通过校验", () => {
  const result = parseStageOutput("itinerary", output("秦始皇帝陵博物院（兵马俑）"));
  assert.equal(result.ok, true);
});

test("新生成 itinerary 的组合地点 spot 被拒绝并说明必须拆分", () => {
  for (const name of ["钟楼和鼓楼", "回民街·钟鼓楼广场", "大雁塔/大唐芙蓉园", "钟楼、鼓楼"]) {
    const result = parseStageOutput("itinerary", output(name));
    assert.equal(result.ok, true, "外层结构应能被解析为 rejected module");
    if (!result.ok) continue;
    const rejected = result.output.modules[0];
    assert.equal(rejected.status, "rejected", `${name} 必须拒绝`);
    assert.match(rejected.reason ?? "", /只能指定一个地点；请将组合地点拆分/);
  }
});

test("组合 spot 在入库前被拒绝，且给出可操作的拆分原因", async () => {
  let writes = 0;
  const runtime = {
    async writeModule() {
      writes += 1;
      return { ok: true };
    },
  };
  const result = await executeStageOutput({
    stage: "itinerary",
    localProductId: "single-spot-contract",
    runtime: runtime as any,
    output: {
      reply: "行程",
      modules: [{
        module: "itinerary",
        status: "accepted",
        value: itineraryWith("回民街·钟鼓楼广场"),
      }],
    },
  });

  assert.equal(writes, 0, "校验失败前不得写入产品");
  assert.equal(result.accepted.length, 0);
  assert.match(result.rejected[0]?.reason ?? "", /只能指定一个地点；请将组合地点拆分/);
});

test("括号内的单点别名不误判为组合地点", () => {
  for (const name of ["西安城墙（永宁门段）", "秦始皇帝陵博物院(兵马俑)", "上海和平饭店", "颐和园景区"]) {
    const result = parseStageOutput("itinerary", output(name));
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.output.modules[0].status, "accepted", `${name} 不应误判为组合地点`);
  }
});

test("历史组合 spot 的 normaliseItinerary 保持原样，不在读取时拆分或改写", () => {
  const result = normaliseItinerary([{ day: 1, title: "旧行程", spots: [{ name: "回民街·钟鼓楼广场", poiName: null, poiId: null }], description: "旧数据", meals: "自理" }]);
  assert.deepEqual(result?.[0].spots, [{ name: "回民街·钟鼓楼广场", poiName: null, poiId: null }]);
});

test("历史字符串 POI ID 在 normaliseItinerary 中收敛为数字，非法值归 null", () => {
  const result = normaliseItinerary([{
    day: 1,
    title: "旧行程",
    spots: [
      { name: "晋祠", poiName: "晋祠博物馆", poiId: "79413" },
      { name: "无效景点", poiName: "无效景点", poiId: "not-a-number" },
      { name: "空景点", poiName: "空景点", poiId: "" },
    ],
    description: "旧数据",
    meals: "自理",
  }]);
  assert.deepEqual(result?.[0].spots, [
    { name: "晋祠", poiName: "晋祠博物馆", poiId: 79413 },
    { name: "无效景点", poiName: "无效景点", poiId: null },
    { name: "空景点", poiName: "空景点", poiId: null },
  ]);
});

test("itinerary tool schema 明确要求一个 spot 只写一个地点", () => {
  const schema = buildStageToolSchema("itinerary");
  const parameters = schema.function.parameters as Record<string, any>;
  const items = parameters.properties.modules.items;
  const branch = items.oneOf?.[0] ?? items;
  const spots = branch.properties.value.items.properties.spots;
  assert.match(spots.description, /只能是一个可独立检索的地点/);
});
