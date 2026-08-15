import test from "node:test";
import assert from "node:assert/strict";

import { navigateToHydratedItinerary } from "../../src/main/automation/ctrip/itinerary/api-entry.js";

test("接口保存后的 tourdays 导航只重试晚到导航造成的 ERR_ABORTED", async () => {
  let calls = 0;
  let currentUrl = "https://vbooking.ctrip.com/ivbk/vendor/productImageText?productId=77050139";
  const clickedSections: string[] = [];
  let hydrated = false;
  const page = {
    waitForLoadState: async () => undefined,
    url: () => currentUrl,
    goto: async (url: string) => {
      calls += 1;
      assert.match(url, /\/ivbk\/vendor\/tourdays\?productid=77050139/);
      currentUrl = "https://vbooking.ctrip.com/ivbk/vendor/tourdays?productid=77050139&from=vbk";
      throw new Error("page.goto: net::ERR_ABORTED");
    },
    evaluate: async (_fn: unknown, arg?: string) => {
      if (arg) {
        clickedSections.push(arg);
        if (arg === "行程描述") hydrated = true;
        return true;
      }
      return hydrated;
    },
  };

  await navigateToHydratedItinerary(page as any, "77050139", { retryDelayMs: 0 });
  assert.equal(calls, 1);
  assert.deepEqual(clickedSections, ["产品图文", "行程描述"],
    "goto 被 SPA 取消但已落到目标页时，下一轮必须通过页签往返重新水合");
});

test("接口保存后的 tourdays 导航遇到非 ERR_ABORTED 立即失败", async () => {
  let calls = 0;
  const page = {
    waitForLoadState: async () => undefined,
    url: () => "https://vbooking.ctrip.com/ivbk/vendor/productImageText?productId=77050139",
    goto: async () => {
      calls += 1;
      throw new Error("page.goto: net::ERR_CERT_DATE_INVALID");
    },
  };

  await assert.rejects(
    () => navigateToHydratedItinerary(page as any, "77050139", { retryDelayMs: 0 }),
    /ERR_CERT_DATE_INVALID/,
  );
  assert.equal(calls, 1);
});
