import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSensitiveWords,
  applySensitiveItineraryRewrite,
  findSensitiveItineraryPaths,
  fillItineraryWithSensitiveRewrite,
} from "../../src/main/automation/automation.main/itinerary-sensitive-rewrite.js";

function product() {
  return {
    itinerary: [
      {
        day: 1,
        title: "第一天",
        spots: [{ name: "王家大院", poiId: 1, poiName: "王家大院" }],
        description: "挑战巅峰景观，尽量轻装上阵。",
        hotel: "",
        meals: "含早",
      },
      {
        day: 2,
        title: "第二天",
        spots: [{ name: "平遥古城", poiId: 2, poiName: "平遥古城" }],
        description: "继续体验当地文化。",
        hotel: "",
        meals: "含餐",
      },
    ],
    operations: {},
  };
}

test("仅定位实际命中的行程描述字段", () => {
  const target = product();
  assert.deepEqual(
    findSensitiveItineraryPaths(target, ["巅峰", "其他"]),
    ["/itinerary/0/description"],
  );
});

test("定位并局部改写 other/free 景点描述，保留名称、类型、顺序与 POI 身份", () => {
  const value = product();
  value.itinerary[0].spots = [
    { name: "镇邦美食街", kind: "other", description: "晚餐打卡镇邦美食街，体验夜骑楼风情。", poiName: "镇邦美食街", poiId: 7 },
    { name: "自由活动", kind: "free", description: "夜骑街区体验", poiName: "官方自由活动", poiId: 8 },
  ];
  assert.deepEqual(findSensitiveItineraryPaths(value, ["夜骑"]), [
    "/itinerary/0/spots/0/description", "/itinerary/0/spots/1/description",
  ]);
  applySensitiveItineraryRewrite(value, {
    reply: "已改写", patch: [
      { op: "replace", path: "/itinerary/0/spots/0/description", value: "晚餐打卡镇邦美食街，体验骑楼街区风情。" },
      { op: "replace", path: "/itinerary/0/spots/1/description", value: "晚间街区漫步体验" },
    ], questions: [], researchTasks: [],
  }, ["夜骑"]);
  assert.deepEqual(value.itinerary[0].spots, [
    { name: "镇邦美食街", kind: "other", description: "晚餐打卡镇邦美食街，体验骑楼街区风情。", poiName: "镇邦美食街", poiId: 7 },
    { name: "自由活动", kind: "free", description: "晚间街区漫步体验", poiName: "官方自由活动", poiId: 8 },
  ]);
});

test("日描述缺失时仍定位 other/free 景点描述", () => {
  const value = product();
  delete (value.itinerary[0] as { description?: string }).description;
  value.itinerary[0].spots = [{ name: "自由活动", kind: "free", description: "夜骑街区体验", poiName: "官方自由活动", poiId: 8 }];
  assert.deepEqual(findSensitiveItineraryPaths(value, ["夜骑"]), ["/itinerary/0/spots/0/description"]);
});

test("AI 重写后仅更新命中的行程描述，其他天保留", () => {
  const value = product();
  applySensitiveItineraryRewrite(
    value,
    {
      reply: "已重写",
      patch: [
        {
          op: "replace",
          path: "/itinerary/0/description",
          value: "挑战高峰景观，尽量轻装上阵。",
        },
      ],
      questions: [],
      researchTasks: [],
    },
    ["巅峰"],
  );

  assert.equal(value.itinerary[0].description, "挑战高峰景观，尽量轻装上阵。");
  assert.equal(value.itinerary[1].description, "继续体验当地文化。");
});

test("AI 重写后仍含敏感词时拒绝落库", () => {
  const value = product();
  assert.throws(() => {
    applySensitiveItineraryRewrite(
      value,
      {
        reply: "已重写",
        patch: [{
          op: "replace",
          path: "/itinerary/0/description",
          value: "挑战巅峰景观，冲击极限。",
        }],
        questions: [],
        researchTasks: [],
      },
      ["巅峰"],
    );
  }, /仍包含平台非法关键词：巅峰/);
});

test("AI 返回未修改命中字段时报错", () => {
  const value = product();
  assert.throws(() => {
    applySensitiveItineraryRewrite(
      value,
      {
        reply: "已重写",
        patch: [{
          op: "replace",
          path: "/itinerary/0/description",
          value: value.itinerary[0].description,
        }],
        questions: [],
        researchTasks: [],
      },
      ["巅峰"],
    );
  }, /AI 未重写命中的行程文案字段/);
});

test("支持解析含空格与结尾提示的非法关键词文案", () => {
  assert.deepEqual(extractSensitiveWords("保存第1天行程描述，提示非法关键词： 巅峰 ，请修改后重新提交"), ["巅峰"]);
  assert.deepEqual(
    extractSensitiveWords("VBK 行程校验(saveType=3)失败：非法关键词：巅峰、极端 ；请修改"),
    ["巅峰", "极端"],
  );
  assert.deepEqual(
    extractSensitiveWords("非法关键词：巅峰,极端，请修改后重新提交"),
    ["巅峰", "极端"],
  );
});

test("审核校验驳回第1天自由活动详情时，只改写该活动文案", () => {
  const value = product();
  value.itinerary[0].activities = [
    { time: "晚上", title: "泡温泉", detail: "体验太白山唐镇南山温泉，含室外汤池与药浴。", type: "free", durationMinutes: 120 },
  ];
  assert.deepEqual(findSensitiveItineraryPaths(value, ["药浴"]), ["/itinerary/0/activities/0/detail"]);
  applySensitiveItineraryRewrite(value, {
    reply: "已改写",
    patch: [{
      op: "replace",
      path: "/itinerary/0/activities/0/detail",
      value: "体验太白山唐镇南山温泉室外汤池。",
    }],
    questions: [], researchTasks: [],
  }, ["药浴"]);
  assert.deepEqual(value.itinerary[0].activities, [
    { time: "晚上", title: "泡温泉", detail: "体验太白山唐镇南山温泉室外汤池。", type: "free", durationMinutes: 120 },
  ]);
});

test("AI 只允许改命中路径：返回其他文案路径时拒绝落库", () => {
  const value = product();
  value.itinerary[0].activities = [
    { time: "晚上", title: "泡温泉", detail: "体验南山温泉药浴。", type: "free" },
  ];
  assert.throws(() => {
    applySensitiveItineraryRewrite(value, {
      reply: "已改写",
      patch: [
        { op: "replace", path: "/itinerary/0/activities/0/detail", value: "体验南山温泉汤池。" },
        { op: "replace", path: "/itinerary/1/description", value: "顺带改写未命中的第二天。" },
      ],
      questions: [], researchTasks: [],
    }, ["药浴"]);
  }, /只能 replace 命中的行程文案字段/);
  assert.equal(value.itinerary[0].activities[0].detail, "体验南山温泉药浴。");
});

test("草稿保存被平台驳回时重写命中文案并重跑保存", async () => {
  const value = product();
  value.itinerary[0].activities = [
    { time: "晚上", title: "泡温泉", detail: "体验太白山唐镇南山温泉，含室外汤池与药浴。", type: "free" },
  ];
  const updates: Array<[string, string, string]> = [];
  let calls = 0;
  const result = await fillItineraryWithSensitiveRewrite({
    ctx: { itineraryCopyRewriter: async () => ({
      reply: "已改写",
      patch: [{ op: "replace", path: "/itinerary/0/activities/0/detail", value: "体验太白山唐镇南山温泉室外汤池。" }],
      questions: [], researchTasks: [],
    }) },
    localProductId: "local",
    product: value,
    log: () => {},
    executeItinerary: async () => {
      calls += 1;
      if (calls === 1) throw new Error("VBK 行程草稿校验(saveType=2)失败（Ack=Failure）：非法关键词：药浴");
      return { savedWith: "itinerary-api", days: 1, apiResult: {} };
    },
    dbUpdate: (id, updated, status) => { updates.push([id, status, (updated as any).itinerary[0].activities[0].detail]); },
  });
  assert.equal(calls, 2);
  assert.equal(result.savedWith, "itinerary-api");
  assert.deepEqual(updates, [["local", "automating", "体验太白山唐镇南山温泉室外汤池。"]]);
  assert.equal(value.itinerary[0].activities[0].detail, "体验太白山唐镇南山温泉室外汤池。");
});

test("没有配置行程文案改写器时如实上抛平台错误", async () => {
  const value = product();
  value.itinerary[0].activities = [{ time: "晚上", title: "泡温泉", detail: "含药浴。", type: "free" }];
  await assert.rejects(fillItineraryWithSensitiveRewrite({
    ctx: {},
    localProductId: "local",
    product: value,
    log: () => {},
    executeItinerary: async () => { throw new Error("非法关键词：药浴"); },
    dbUpdate: () => {},
  }), /非法关键词：药浴/);
});
