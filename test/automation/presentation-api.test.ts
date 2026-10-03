import test from "node:test";
import assert from "node:assert/strict";
import { savePresentationViaApi } from "../../src/main/automation/ctrip/presentation/presentation-api.js";
import { buildRecommendationReasonsPlan } from "../../src/main/automation/ctrip/presentation/recommendations.js";
import { PresentationCopyRejectedError } from "../../src/main/automation/ctrip/presentation/copy-errors.js";

function browserWithResponses(responses: Array<{ status: number; payload: unknown }>) {
  const calls: Array<{ endpoint: string; body: unknown }> = [];
  return {
    calls,
    url: () => "https://vbooking.ctrip.com/product/input/productImageText?productId=77098084&pattern=4&from=vbk",
    async evaluate(_fn: unknown, args: { endpoint: string; body: unknown }) {
      calls.push({ endpoint: args.endpoint, body: args.body });
      if (args.endpoint.endsWith("getProductBaseInfo")) return { status: 200, payload: { ResponseStatus: { Ack: "Success" }, saleControlInfo: { pICategoryId: 1003, inputLocale: "zh-CN" } }, durationMs: 1, ctx: {} };
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
    { category: "优选行程", text: "2天串起西安古城中轴与临潼盛唐地标，行程节奏合理不赶路，体验更深入" },
    { category: "精选酒店", text: "入住钟楼/南门商圈当地5钻酒店，方便每日出行与休息，整体体验更舒适" },
    { category: "缤纷景点", text: "覆盖城墙、钟鼓楼、兵马俑等核心景点，兼顾古建与人文，行程内容更丰富" },
  ],
  features: "<p><strong>私家团：</strong>专车专导。</p>",
};

function submissionResponses(save: unknown, features = presentation.features) {
  return [
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, pmRcmdCategories: [
      { pmRcmdCategoryId: 9, pmRcmdCategoryName: "优选行程" },
      { pmRcmdCategoryId: 3, pmRcmdCategoryName: "精选酒店" },
      { pmRcmdCategoryId: 5, pmRcmdCategoryName: "缤纷景点" },
    ] } },
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, info: {} } },
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, sensitiveWords: [] } },
    { status: 200, payload: { ResponseStatus: { Ack: "Success" } } },
    { status: 200, payload: save },
    { status: 200, payload: { ResponseStatus: { Ack: "Success" }, info: {
      pmRcmdItems: buildRecommendationReasonsPlan(presentation.recommendations).map(item => ({ rcmdDesc: item.text })),
      productDesc: { productDesc: features },
    } } },
  ];
}

test("保存接口 Ack Warning 的非法词归一化为可恢复错误", async () => {
  const browser = browserWithResponses(submissionResponses({ ResponseStatus: { Ack: "Warning", Errors: [{ Message: "非法关键词：江鲜" }] } }));
  await assert.rejects(savePresentationViaApi(browser as never, presentation), (error: unknown) => {
    assert.ok(error instanceof PresentationCopyRejectedError);
    assert.deepEqual(error.sensitiveWords, ["江鲜"]);
    assert.equal(error.source, "savedescriptioninfo");
    assert.match(error.message, /Ack=Warning/);
    return true;
  });
});

test("success false 的非法词可恢复，一般 Warning 不伪装成敏感词", async () => {
  const sensitive = browserWithResponses(submissionResponses({ ResponseStatus: { Ack: "Success" }, success: false, checkErrMsg: "非法关键词：江鲜、野味，请修改" }));
  await assert.rejects(savePresentationViaApi(sensitive as never, presentation), (error: unknown) => {
    assert.ok(error instanceof PresentationCopyRejectedError);
    assert.deepEqual(error.sensitiveWords, ["江鲜", "野味"]);
    return true;
  });
  const generic = browserWithResponses(submissionResponses({ ResponseStatus: { Ack: "Warning", Errors: [{ Message: "库存错误" }] } }));
  await assert.rejects(savePresentationViaApi(generic as never, presentation), (error: unknown) => {
    assert.ok(error instanceof Error && !(error instanceof PresentationCopyRejectedError));
    assert.match(error.message, /库存错误/);
    return true;
  });
});

test("HTTP 失败即使包含非法词也保持为 HTTP 错误", async () => {
  const responses = submissionResponses({ checkErrMsg: "非法关键词：江鲜" });
  responses[4]!.status = 403;
  await assert.rejects(savePresentationViaApi(browserWithResponses(responses) as never, presentation), /HTTP 403/);
});

test("特色只有前 40 字一致不算回读成功", async () => {
  const prefix = "这是一段共同内容".repeat(8);
  const copy = { ...presentation, features: `<p>${prefix}改后的尾部</p>` };
  const browser = browserWithResponses(submissionResponses({ ResponseStatus: { Ack: "Success" }, success: true }, `<p>${prefix}旧的尾部</p>`));
  await assert.rejects(savePresentationViaApi(browser as never, copy), /产品特色回读不一致/);
});

test("图文每次写入前重查权限，检查失败后不提交保存", async () => {
  const browser = browserWithResponses(submissionResponses({ ResponseStatus: { Ack: "Success" }, success: true }));
  let guards = 0;
  await assert.rejects(savePresentationViaApi(browser as never, presentation, undefined, {
    beforeWrite: async () => { if (++guards === 2) throw new Error("已暂停"); },
  }), /已暂停/);
  assert.equal(browser.calls.filter(call => call.endpoint.endsWith("savedescriptioninfo")).length, 0);
});

test("保存响应丢失后先回读，已保存则不再次提交", async () => {
  const responses = submissionResponses({});
  const browser = browserWithResponses(responses);
  const evaluate = browser.evaluate;
  browser.evaluate = async (fn, args) => {
    if (args.endpoint.endsWith("savedescriptioninfo")) {
      responses.shift();
      browser.calls.push({ endpoint: args.endpoint, body: args.body });
      throw new Error("响应丢失");
    }
    return evaluate(fn, args);
  };
  const result = await savePresentationViaApi(browser as never, presentation);
  assert.equal(result.featuresSaved, true);
  assert.equal(browser.calls.filter(call => call.endpoint.endsWith("savedescriptioninfo")).length, 1);
});

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
  assert.match(browser.calls[3].endpoint, /checkSensitiveWord$/);
  assert.match(browser.calls[4].endpoint, /createProductDraft$/);
  assert.match(browser.calls[5].endpoint, /savedescriptioninfo$/);
  assert.match(browser.calls[6].endpoint, /getdescriptionInfo$/);

  const saveBody = browser.calls[5].body as any;
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
  assert.equal(browser.calls.length, 4);
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
  assert.equal((browser.calls[5].body as any).dto.productId, 77098085);
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

 test("图文预检查使用远端产品分类与语言", async () => {
 const browser = browserWithResponses(submissionResponses({ ResponseStatus: { Ack: "Success" }, success: true }));
 await savePresentationViaApi(browser as never, presentation);
 const body = browser.calls.find(c => c.endpoint.endsWith("checkSensitiveWord"))!.body as any;
 assert.equal(body.categoryId, 1003); assert.deepEqual(body.requestBaseData, { locale: "zh-CN" });
});
