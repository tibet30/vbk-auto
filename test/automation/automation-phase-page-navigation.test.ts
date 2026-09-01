import assert from "node:assert/strict";
import test from "node:test";
import {
  enterPhasePageForApi,
  executeApiWithPhasePageSync,
  recordPhaseRetry,
  refreshPhasePageAfterApi,
} from "../../src/main/automation/automation.main/automation.main.retry-navigation.js";

test("每个 API 模块在执行前进入对应页面，并在成功后刷新该页面", async () => {
  const events: string[] = [];
  let currentUrl = "";
  const page = {
    goto: async (url: string) => { currentUrl = url; events.push(`goto:${url}`); },
    reload: async () => { events.push("reload"); },
    waitForLoadState: async () => { events.push("ready"); },
    url: () => currentUrl,
  };
  const log = (message: string) => events.push(`log:${message}`);

  await enterPhasePageForApi({ page, productId: "77752371", phase: "package", log });
  await refreshPhasePageAfterApi({ page, productId: "77752371", phase: "package", log });

  assert.match(events[0], /^log:phase=package 准备录入/);
  assert.match(events[1], /goto:.*packageManage\?productid=77752371/);
  assert.equal(events.filter((event) => event === "reload").length, 1);
  assert.ok(events.some((event) => event.includes("API 远端回读完成：刷新当前模块页面")));
});

test("preflight 使用基本信息页作为没有独立页面时的编辑器上下文", async () => {
  const gotos: string[] = [];
  const page = {
    goto: async (url: string) => { gotos.push(url); },
    reload: async () => undefined,
  };
  await enterPhasePageForApi({ page, productId: "77752371", phase: "preflight", log: () => undefined });
  assert.match(gotos[0], /baseInfoMerge\?productId=77752371/);
});

test("Electron BrowserView 存在时，阶段切页复用受保护的浏览器导航", async () => {
  const navigated: string[] = [];
  const page = {
    goto: async () => { throw new Error("不应绕过 VbkBrowser.navigate 调用 page.goto"); },
    reload: async () => undefined,
    url: () => navigated.at(-1) ?? "",
  };

  await enterPhasePageForApi({
    page,
    productId: "77752371",
    phase: "package",
    log: () => undefined,
    navigate: async (url) => { navigated.push(url); },
  });

  assert.equal(navigated.length, 1);
  assert.match(navigated[0], /packageManage\?productid=77752371/);
});

test("远端回读已成功时，页面刷新失败只记录警告，不使业务阶段失败", async () => {
  const logs: Array<{ message: string; level?: string }> = [];
  const page = {
    goto: async () => undefined,
    reload: async () => { throw new Error("net::ERR_ABORTED"); },
  };

  await assert.doesNotReject(refreshPhasePageAfterApi({
    page,
    productId: "77752371",
    phase: "itinerary",
    log: (message, level) => logs.push({ message, level }),
  }));

  assert.ok(logs.some(({ level, message }) => level === "warning" && message.includes("远端回读已确认") && message.includes("ERR_ABORTED")));
});

test("阶段开始时右侧关闭，执行中途打开也不误刷新当前页面", async () => {
  const events: string[] = [];
  let visible = false;
  const page = {
    goto: async (url: string) => { events.push(`goto:${url}`); },
    reload: async () => { events.push("reload"); },
  };

  const result = await executeApiWithPhasePageSync({
    page,
    productId: "77752371",
    phase: "presentation",
    log: (message) => events.push(`log:${message}`),
    isPageVisible: () => visible,
    ensureBrowserHasBounds: () => events.push("bounds"),
    navigate: async (url) => { events.push(`navigate:${url}`); },
    executeApi: async () => {
      events.push("api");
      visible = true;
      return "saved";
    },
  });

  assert.equal(result, "saved");
  assert.deepEqual(events.filter((event) => event === "reload" || event.startsWith("navigate:")), []);
  assert.ok(events.some((event) => event.includes("跳过页面进入")));
  assert.ok(events.some((event) => event.includes("跳过页面刷新")));
});

test("阶段开始时右侧打开，执行期间关闭仍只完成本阶段的一次页面同步", async () => {
  const events: string[] = [];
  let visible = true;
  let currentUrl = "";
  const page = {
    goto: async () => undefined,
    reload: async () => { events.push("reload"); },
    url: () => currentUrl,
  };

  await executeApiWithPhasePageSync({
    page,
    productId: "77752371",
    phase: "itinerary",
    log: (message) => events.push(`log:${message}`),
    isPageVisible: () => visible,
    ensureBrowserHasBounds: () => events.push("bounds"),
    navigate: async (url) => { currentUrl = url; events.push(`navigate:${url}`); },
    executeApi: async () => {
      events.push("api");
      visible = false;
    },
  });

  assert.equal(events.filter((event) => event.startsWith("navigate:")).length, 1);
  assert.equal(events.filter((event) => event === "reload").length, 1);
  assert.ok(events.indexOf("api") > events.findIndex((event) => event.startsWith("navigate:")));
  assert.ok(events.indexOf("reload") > events.indexOf("api"));
});

test("恢复动作不导航；每次 attempt 只由执行前入口进入一次目标页面", async () => {
  const events: string[] = [];
  let currentUrl = "";
  const page = {
    goto: async (url: string) => {
      currentUrl = url;
      events.push(`goto:${url}`);
    },
    reload: async () => undefined,
    url: () => currentUrl,
  };
  const log = (message: string) => events.push(`log:${message}`);

  // 这个测试模拟 recovery 的 action → 下一次 execute 顺序。action 本身不接收
  // page，因而不能发起第二次导航；实际页面进入仍带 URL 校验。
  let attempt = 0;
  const execute = async () => {
    attempt += 1;
    await enterPhasePageForApi({ page, productId: "77752371", phase: "itinerary", log });
  };
  await execute();
  recordPhaseRetry({ productId: "77752371", phase: "itinerary", action: "reload_and_retry_phase", attempt: 1, log });
  await execute();

  assert.equal(events.filter((event) => event.startsWith("goto:")).length, 2);
  assert.match(events[1], /tourdays/);
  assert.ok(events.some((event) => event.includes("下一次执行将在录入前进入模块页面")));
});
