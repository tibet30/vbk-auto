import test from "node:test";
import assert from "node:assert/strict";
import { submitWithFormalCardRecovery } from "../../src/main/automation/ctrip/traffic-line/card-submit-recovery.js";

for (const [resource, card] of [["机票", "航班"], ["火车票", "火车"]]) {
  const rejection = new Error(`子产品资源提交未通过：资源配置中含有${resource}资源，需要行程描述中先添加${card}信息卡片。`);
  test(`${card} first-submit rejection continues only after formal resource verification`, async () => {
    const calls: string[] = [];
    await submitWithFormalCardRecovery({
      submit: async () => { calls.push("submit"); throw rejection; },
      readFormalResources: async () => { calls.push("verify-formal"); },
      onRecovery: () => { calls.push("continue-itinerary"); },
    });
    assert.deepEqual(calls, ["submit", "verify-formal", "continue-itinerary"]);
  });
  test(`${card} rejection with missing formal resources must remain blocked`, async () => {
    let continued = false;
    await assert.rejects(() => submitWithFormalCardRecovery({
      submit: async () => { throw rejection; },
      readFormalResources: async () => { throw new Error("正式资源为空"); },
      onRecovery: () => { continued = true; },
    }), /正式资源为空/);
    assert.equal(continued, false);
  });
}

test("unknown, pending and authorization failures cannot enter card recovery", async () => {
  let reads = 0;
  for (const message of ["网络超时", "子产品资源提交仍在 VBK 异步核验", "没有当前资源的权限"]) {
    await assert.rejects(() => submitWithFormalCardRecovery({
      submit: async () => { throw new Error(message); },
      readFormalResources: async () => { reads++; },
    }), { message });
  }
  assert.equal(reads, 0);
});

test("successful submit needs no exceptional recovery read", async () => {
  await submitWithFormalCardRecovery({
    submit: async () => {},
    readFormalResources: async () => { assert.fail("unnecessary recovery"); },
  });
});
