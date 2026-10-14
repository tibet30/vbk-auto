import assert from "node:assert/strict";
import test from "node:test";
import { buildAutomationHandlers } from "../../src/main/automation/automation.main/automation.main.run/handlers.ts";
import { AutomationCancelledError } from "../../src/main/automation/automation.main/automation.main.errors.ts";
import { buildBasicExecute } from "../../src/main/automation/automation.main/runtime/basic.ts";
import { unlockedMenus } from "./product-menu-fixture.ts";

const LOCAL_PRODUCT_ID = "local-wizard-recovery";
const PRODUCT_ID = "79712643";

type RecoveryPhase = "basic" | "presentation";

function pageFixture(initialStep: -80 | -70) {
  let step = initialStep;
  const calls: string[] = [];
  const writes: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  let navigations = 0;
  const page = {
    waitForTimeout: async () => {},
    withRequestSource: async <T>(_url: string, execute: () => Promise<T>) => execute(),
    goto: async () => { navigations += 1; },
    reload: async () => {},
    evaluate: async (_fn: unknown, request: { endpoint: string; body: Record<string, unknown> }) => {
      const endpoint = request.endpoint.split("/").at(-1)!;
      calls.push(endpoint);
      if (endpoint === "getSubMenu.json") {
        const enabledCount = step === -80 ? 2 : step === -70 ? 3 : 4;
        const payload = unlockedMenus(PRODUCT_ID);
        payload.maxStep = step;
        payload.menus = payload.menus.map((menu, index) => ({
          ...menu, enabled: index < enabledCount ? "T" : "F",
        }));
        return success(payload);
      }
      if (endpoint === "getProductBaseInfo") {
        return success({
          baseInfo: { productId: Number(PRODUCT_ID), mainName: "既有产品名称" },
          nameAreas: [],
          bookingControls: { minPersonQuantity: 1, maxPersonQuantity: 10 },
          meta: { saveStep: step },
        });
      }
      if (endpoint === "getdescriptionInfo") {
        return success({ info: {
          productDesc: { id: Number(PRODUCT_ID), productDesc: "既有产品图文" },
          pmRcmdItems: [{ rcmdDesc: "既有推荐", pmRcmdCategoryId: 9 }],
        } });
      }
      if (["saveProductBaseInfo", "createProductDraft", "savedescriptioninfo"].includes(endpoint)) {
        writes.push({ endpoint, body: request.body });
        if (endpoint === "saveProductBaseInfo") step = -70;
        if (endpoint === "savedescriptioninfo") step = -60;
        return success({});
      }
      throw new Error(`恢复路径不应调用业务内容保存接口：${endpoint}`);
    },
  };
  return { page, calls, writes, navigations: () => navigations };
}

function success(payload: Record<string, unknown>) {
  return {
    status: 200,
    payload: { ResponseStatus: { Ack: "Success" }, ...payload },
    durationMs: 1,
    ctx: {},
  };
}

function run(phase: RecoveryPhase) {
  return { id: `run-${phase}`, status: "running" as const, logs: [], phases: [{ phase, status: "pending" as const }] };
}

function context(cancellationRequested: Set<string>, assertWriteAuthorized: (id: string, phase: string) => Promise<void>) {
  return {
    agentControlled: true,
    assertWriteAuthorized,
    cancellationRequested,
    db: {},
    browser: { isVisible: () => false, navigate: async () => {} },
    ensureBrowserHasBounds: () => {},
    runVbkPageExclusive: async <T>(execute: () => Promise<T>) => execute(),
  } as any;
}

function executeRecoveryHandler(
  phase: RecoveryPhase,
  input: { page: any; ctx: any },
) {
  const currentRun = run(phase);
  const setup = {
    productDetail: { id: LOCAL_PRODUCT_ID, productId: PRODUCT_ID },
    product: {},
    run: currentRun,
    page: input.page,
    log: () => {},
    persist: () => {},
    basicInfoSaved: true,
    productLineBlocked: false,
    scenicSpotLogs: [],
    wizardAdvanceOnly: new Set([phase]),
  } as any;
  if (phase === "basic") {
    return buildBasicExecute(input.ctx, setup, { current: PRODUCT_ID });
  }
  return buildAutomationHandlers(input.ctx, setup, { current: PRODUCT_ID }).presentation;
}

test("向导恢复通过真实 basic/presentation 处理器只调用各自官方下一步，不重存业务内容", async () => {
  const basic = pageFixture(-80);
  const basicAuthorizations: string[] = [];
  await executeRecoveryHandler("basic", {
    page: basic.page,
    ctx: context(new Set(), async (_id, phase) => { basicAuthorizations.push(phase); }),
  })();
  assert.deepEqual(basicAuthorizations, ["basic"]);
  assert.deepEqual(basic.writes.map(write => write.endpoint), ["saveProductBaseInfo"]);
  assert.deepEqual(basic.calls, ["getSubMenu.json", "getProductBaseInfo", "saveProductBaseInfo", "getSubMenu.json"]);
  assert.equal(basic.navigations(), 0);

  const presentation = pageFixture(-70);
  const presentationAuthorizations: string[] = [];
  await executeRecoveryHandler("presentation", {
    page: presentation.page,
    ctx: context(new Set(), async (_id, phase) => { presentationAuthorizations.push(phase); }),
  })();
  assert.deepEqual(presentationAuthorizations, ["presentation", "presentation"]);
  assert.deepEqual(presentation.writes.map(write => write.endpoint), ["createProductDraft", "savedescriptioninfo"]);
  assert.deepEqual(presentation.calls, [
    "getSubMenu.json", "getProductBaseInfo", "getdescriptionInfo",
    "createProductDraft", "savedescriptioninfo", "getSubMenu.json",
  ]);
  assert.equal(presentation.navigations(), 0);
});

test("恢复处理器在异步授权后发现取消时，不发送 basic 或图文下一步写入", async () => {
  for (const [phase, initialStep] of [["basic", -80], ["presentation", -70]] as const) {
    const fixture = pageFixture(initialStep);
    const cancelled = new Set<string>();
    const authorizations: string[] = [];
    const handler = executeRecoveryHandler(phase, {
      page: fixture.page,
      ctx: context(cancelled, async (id, checkedPhase) => {
        authorizations.push(checkedPhase);
        await Promise.resolve();
        cancelled.add(id);
      }),
    });
    await assert.rejects(handler, AutomationCancelledError, phase);
    assert.deepEqual(authorizations, [phase], phase);
    assert.deepEqual(fixture.writes, [], phase);
    assert.equal(fixture.navigations(), 0, phase);
  }
});
