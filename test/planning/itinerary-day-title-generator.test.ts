import test from "node:test";
import assert from "node:assert/strict";
import { generateItineraryDayTitles } from "../../src/main/minimax/itinerary-day-title-generator.js";
import type { ItineraryDayTitleRequest } from "../../src/main/planning/itinerary-day-titles.js";

function clientOf(payload: unknown) {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: {
              tool_calls: [{
                type: "function",
                function: { name: "submit_itinerary_day_titles", arguments: JSON.stringify(payload) },
              }],
            },
          }],
        }),
      },
    },
  } as never;
}

const requests: ItineraryDayTitleRequest[] = [
  { day: 1, maxLength: 70, requiredNames: [], routeNodes: [], startName: "延吉", stayAllowed: true,
    stayName: "", includeNotes: [], freeActivityOnly: false, currentTitle: "", sourceText: "", hotel: "" },
  { day: 2, maxLength: 70, requiredNames: [], routeNodes: [], startName: "延吉", stayAllowed: false,
    stayName: "", includeNotes: [], freeActivityOnly: false, currentTitle: "", sourceText: "", hotel: "" },
];

test("模型返回个别坏项时只跳过坏项，好项照常采纳", async () => {
  const result = await generateItineraryDayTitles(clientOf({
    titles: [{ day: { broken: true }, title: "错位结构" }, { day: 2, title: "二道白河-长白山北坡" }],
  }), "test-model", requests);
  assert.deepEqual(result.titles, [{ day: 2, title: "二道白河-长白山北坡" }]);
});

test("模型返回缺字段或空标题的项也按坏项跳过", async () => {
  const result = await generateItineraryDayTitles(clientOf({
    titles: [{ day: 1, title: "   " }, { day: "2", title: "二道白河-送站" }],
  }), "test-model", requests);
  assert.deepEqual(result.titles, [{ day: 2, title: "二道白河-送站" }]);
});

test("整批都不可用时抛出，交给上层重试或兜底", async () => {
  await assert.rejects(
    generateItineraryDayTitles(clientOf({ titles: [{ day: null, title: 42 }] }), "test-model", requests),
    /未返回结构化天标题/u,
  );
  await assert.rejects(
    generateItineraryDayTitles(clientOf({ nothing: true }), "test-model", requests),
    /未返回结构化天标题/u,
  );
});

test("没有需要生成的天时不发起模型调用", async () => {
  const result = await generateItineraryDayTitles(clientOf({ titles: [] }), "test-model", []);
  assert.deepEqual(result.titles, []);
  assert.equal(result.response, undefined);
});
