import test from "node:test";
import assert from "node:assert/strict";
import { savePresentationViaApi } from "../../src/main/automation/ctrip/presentation/presentation-api.js";
import { buildRecommendationReasonsPlan } from "../../src/main/automation/ctrip/presentation/recommendations.js";

function browserWithResponses(responses: Array<{ status: number; payload: unknown }>) {
  const calls: Array<{ endpoint: string; body: unknown }> = [];
  return {
    calls,
    url: () => "https://vbooking.ctrip.com/product/input/productImageText?productId=77098084&pattern=4&from=vbk",
    async evaluate(_fn: unknown, args: { endpoint: string; body: unknown }) {
      calls.push({ endpoint: args.endpoint, body: args.body });
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return {
        ...next,
        durationMs: 1,
        ctx: {
          hasCid: true,
          cookieNameCount: 1,
          hasGuidCookie: true,
          hasVbkLoginCidCookie: false,
          hasUbtVidCookie: false,
          hasVbkTicketCookie: true,
          hasBticketCookie: false,
          hasJsSessionIdCookie: true,
          hasBusinessIdCookie: false,
          hasBfaCookie: false,
          responseAck: "Success",
          responseDataItemCount: 1,
        },
      };
    },
  };
}

const presentation = {
  recommendation: "2天1晚私家团，专车专导慢游西安。",
  recommendations: [
    { category: "优选行程", text: "2天串起西安古城中轴与临潼盛唐地标。" },
    { category: "精选酒店", text: "入住钟楼/南门商圈当地5钻酒店。" },
    { category: "缤纷景点", text: "覆盖城墙、钟鼓楼、兵马俑等核心景点。" },
  ],
  features: "<p><strong>私家团：</strong>专车专导。</p>",
};

test("产品图文接口保存：旧兼容富文本字段 + 推荐理由回读确认", async () => {
  const recommendationPlan = buildRecommendationReasonsPlan(presentation.recommendations);
  const browser = browserWithResponses([
    {
      status: 200,
      payload: {
        ResponseStatus: { Ack: "Success" },
        pmRcmdCategories: [
          { pmRcmdCategoryId: 9, pmRcmdCategoryName: "优选行程" },
          { pmRcmdCategoryId: 3, pmRcmdCategoryName: "精选酒店" },
          { pmRcmdCategoryId: 5, pmRcmdCategoryName: "缤纷景点" },
        ],
      },
    },
    {
      status: 200,
      payload: {
        ResponseStatus: { Ack: "Success" },
        info: {
          pmRcmdItems: [
            { id: 1, pmRcmdCategoryId: 9, url: "" },
            { id: 2, pmRcmdCategoryId: 3, url: "" },
          ],
          productDesc: { id: 77098084, isBindTravelInfo: true },
          productDescNew: {},
          addInfoCode: "A1",
        },
      },
    },
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, sensitiveWords: [] } },
    { status: 200, payload: { ResponseStatus: { Ack: "Success" } } },
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, success: true } },
    {
      status: 200,
      payload: {
        ResponseStatus: { Ack: "Success" },
        info: {
          pmRcmdItems: [
            { id: 1, pmRcmdCategoryId: 9, rcmdDesc: recommendationPlan[0].text },
            { id: 2, pmRcmdCategoryId: 3, rcmdDesc: recommendationPlan[1].text },
            { id: 3, pmRcmdCategoryId: 5, rcmdDesc: recommendationPlan[2].text },
          ],
          productDesc: {
            id: 77098084,
            productDesc: presentation.features,
            isBindTravelInfo: true,
          },
          productDescNew: {},
        },
      },
    },
  ]);

  const result = await savePresentationViaApi(browser as never, presentation);
  assert.deepEqual(result, {
    productId: 77098084,
    recommendationCount: 3,
    featuresSaved: true,
    savedWith: "presentation-api",
  });

  assert.match(browser.calls[0].endpoint, /getpmrcmdcategory\.json$/);
  assert.match(browser.calls[1].endpoint, /getdescriptionInfo$/);
  assert.match(browser.calls[2].endpoint, /checkSensitiveWord$/);
  assert.match(browser.calls[3].endpoint, /createProductDraft$/);
  assert.match(browser.calls[4].endpoint, /savedescriptioninfo$/);
  assert.match(browser.calls[5].endpoint, /getdescriptionInfo$/);

  const saveBody = browser.calls[4].body as any;
  assert.equal(saveBody.dto.productId, 77098084);
  assert.equal(saveBody.dto.productDesc.productDesc, presentation.features);
  assert.equal(saveBody.dto.productDescNew, null);
  assert.equal(saveBody.dto.addInfoCode, "A1");
  assert.deepEqual(
    saveBody.dto.pmRcmdItems.map((item: any) => ({
      id: item.id,
      pmRcmdCategoryId: item.pmRcmdCategoryId,
      pmRcmdCategoryName: item.pmRcmdCategoryName,
      rcmdDesc: item.rcmdDesc,
      sortOrder: item.sortOrder,
    })),
    [
      { id: 1, pmRcmdCategoryId: 9, pmRcmdCategoryName: "优选行程", rcmdDesc: recommendationPlan[0].text, sortOrder: 1 },
      { id: 2, pmRcmdCategoryId: 3, pmRcmdCategoryName: "精选酒店", rcmdDesc: recommendationPlan[1].text, sortOrder: 2 },
      { id: undefined, pmRcmdCategoryId: 5, pmRcmdCategoryName: "缤纷景点", rcmdDesc: recommendationPlan[2].text, sortOrder: 3 },
    ],
  );
});

test("产品图文接口保存：敏感词命中时不创建草稿也不保存", async () => {
  const browser = browserWithResponses([
    {
      status: 200,
      payload: {
        ResponseStatus: { Ack: "Success" },
        pmRcmdCategories: [
          { pmRcmdCategoryId: 9, pmRcmdCategoryName: "优选行程" },
          { pmRcmdCategoryId: 3, pmRcmdCategoryName: "精选酒店" },
          { pmRcmdCategoryId: 5, pmRcmdCategoryName: "缤纷景点" },
        ],
      },
    },
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, info: {} } },
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, sensitiveWords: ["首发"] } },
  ]);
  await assert.rejects(
    savePresentationViaApi(browser as never, presentation),
    /产品图文触发敏感词/,
  );
  assert.equal(browser.calls.length, 3);
});

test("产品图文接口保存：显式产品 ID 不读取页面 URL", async () => {
  const browser = browserWithResponses([
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, pmRcmdCategories: [
      { pmRcmdCategoryId: 9, pmRcmdCategoryName: "优选行程" },
      { pmRcmdCategoryId: 3, pmRcmdCategoryName: "精选酒店" },
      { pmRcmdCategoryId: 5, pmRcmdCategoryName: "缤纷景点" },
    ] } },
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, info: {} } },
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, sensitiveWords: [] } },
    { status: 200, payload: { ResponseStatus: { Ack: "Success" } } },
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, success: true } },
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, info: {
      pmRcmdItems: buildRecommendationReasonsPlan(presentation.recommendations).map((item) => ({ rcmdDesc: item.text })),
      productDesc: { productDesc: presentation.features },
    } } },
  ]);
  browser.url = () => { throw new Error("production path must not read page.url"); };
  const result = await savePresentationViaApi(browser as never, presentation, 77098085);
  assert.equal(result.productId, 77098085);
  assert.equal((browser.calls[1].body as any).productId, 77098085);
  assert.equal((browser.calls[4].body as any).dto.productId, 77098085);
});

test("产品图文接口保存：推荐理由不得描述不含导游", () => {
  assert.throws(
    () => buildRecommendationReasonsPlan([
      { category: "优选行程", text: "行程自由安排，不配随队导游。" },
      { category: "精选酒店", text: "入住当地酒店。" },
      { category: "缤纷景点", text: "覆盖核心景点。" },
    ]),
    /导游否定描述/,
  );
});

test("产品图文接口保存：产品特色不得描述不含导游", async () => {
  const browser = browserWithResponses([]);
  await assert.rejects(
    savePresentationViaApi(browser as never, {
      ...presentation,
      features: "<p><strong>自由安排：</strong>不含导游，轻松游览。</p>",
    }),
    /产品特色命中 VBK 文案黑名单「导游否定描述」/,
  );
  assert.equal(browser.calls.length, 0);
});
