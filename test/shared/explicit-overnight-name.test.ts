import assert from "node:assert/strict";
import test from "node:test";
import { explicitOvernightName } from "../../src/shared/explicit-overnight-name.js";

test("括号、住宿动词与行内简写都能取到当晚住宿地", () => {
  assert.equal(explicitOvernightName("D1：抵达韶山（宿韶山）"), "韶山");
  assert.equal(explicitOvernightName("D1：晚上住宿：岳阳"), "岳阳");
  assert.equal(explicitOvernightName("D1：游览后；宿韶山酒店"), "韶山酒店");
  // 简写后的冒号只是分隔符，不能带进住宿地名。
  assert.equal(explicitOvernightName("D1：游览后；宿：韶山"), "韶山");
  assert.equal(explicitOvernightName("D1：游览后；宿 韶山"), "韶山");
});

test("行内简写的分隔符与动词变体都能取到住宿地", () => {
  // 运营常用 `|`/`｜` 收尾写当晚住宿，「|宿X」不带空格同样要认。
  assert.equal(explicitOvernightName("D3：祁连 — 祁连黑河源 |宿肃南"), "肃南");
  assert.equal(explicitOvernightName("D3：祁连 — 祁连黑河源｜宿肃南"), "肃南");
  assert.equal(explicitOvernightName("D3：祁连 — 祁连黑河源 宿在肃南"), "肃南");
  assert.equal(explicitOvernightName("D3：祁连 — 祁连黑河源 宿于肃南"), "肃南");
  assert.equal(explicitOvernightName("D3：祁连 — 祁连黑河源 夜宿肃南"), "肃南");
  assert.equal(explicitOvernightName("D3：祁连 — 祁连黑河源 当晚宿肃南"), "肃南");
  assert.equal(explicitOvernightName("D3：祁连 — 祁连黑河源 晚宿肃南"), "肃南");
});

test("住宿地名与「住宿」本身不被当成简写", () => {
  assert.equal(explicitOvernightName("D1：宿州古城"), undefined);
  assert.equal(explicitOvernightName("D1：太原武宿机场"), undefined);
  assert.equal(explicitOvernightName("D1：今日住宿"), undefined);
  assert.equal(explicitOvernightName(undefined), undefined);
});
