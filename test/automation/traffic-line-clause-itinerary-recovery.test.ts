import test from "node:test";
import assert from "node:assert/strict";
import { settleTrafficLineClausesBeforeActivation } from "../../src/main/automation/ctrip/traffic-line/clause-itinerary-recovery.js";

function fixture(message = "子产品资源回读尚未生成飞机去返程条款，未保存条款，可安全重试。", missing = true) {
  const calls: string[] = [];
  return { calls, args: {
    settleClauses: async () => { calls.push("settle"); throw new Error(message); },
    itineraryNeedsRepair: async () => { calls.push("read-itinerary"); return missing; },
    repairItinerary: async () => { calls.push("repair-itinerary"); },
    saveClauses: async () => { calls.push("save-clauses"); },
    verifyClauses: async () => { calls.push("verify-clauses"); },
  } };
}

test("条款保存后资源迟到回绑丢失交通节点，激活前只定向修复一次并回读", async () => {
  const f = fixture();
  await settleTrafficLineClausesBeforeActivation(f.args);
  assert.deepEqual(f.calls, ["settle", "read-itinerary", "repair-itinerary", "save-clauses", "verify-clauses"]);
});

test("行程节点仍在时不能用重写行程掩盖资源条款未就绪", async () => {
  const f = fixture(undefined, false);
  await assert.rejects(() => settleTrafficLineClausesBeforeActivation(f.args), /尚未生成飞机去返程条款/);
  assert.deepEqual(f.calls, ["settle", "read-itinerary"]);
});

test("未知条款或会话错误立即阻断，不进行行程写入", async () => {
  const f = fixture("登录失效");
  await assert.rejects(() => settleTrafficLineClausesBeforeActivation(f.args), /登录失效/);
  assert.deepEqual(f.calls, ["settle"]);
});

test("定向修复失败不重复提交，也不提前激活", async () => {
  const f = fixture();
  f.args.saveClauses = async () => { f.calls.push("save-clauses"); throw new Error("条款仍未收敛"); };
  await assert.rejects(() => settleTrafficLineClausesBeforeActivation(f.args), /条款仍未收敛/);
  assert.deepEqual(f.calls, ["settle", "read-itinerary", "repair-itinerary", "save-clauses"]);
});
