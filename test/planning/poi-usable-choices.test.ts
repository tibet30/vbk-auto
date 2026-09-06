import assert from "node:assert/strict";
import test from "node:test";
import { chooseUsablePoiOptions } from "../../src/main/planning/poi-usable-choices.js";

test("多个候选先按可用性过滤，只保留能用的", () => {
  const result = chooseUsablePoiOptions([
    { name: "日喀则博物馆", usable: true, reason: undefined },
    { name: "日喀则非物质遗产中心", usable: false, reason: "暂停营业" },
    { name: "日喀则文化馆", usable: true, reason: undefined },
  ]);
  assert.equal(result.kind, "choose");
  assert.deepEqual(result.kind === "choose" ? result.options.map((item) => item.name) : [], [
    "日喀则博物馆",
    "日喀则文化馆",
  ]);
});

test("仅一个能用时自动采用", () => {
  const result = chooseUsablePoiOptions([
    { name: "日喀则博物馆", usable: true },
    { name: "日喀则非物质遗产中心", usable: false, reason: "未查到可绑定 POI" },
  ]);
  assert.equal(result.kind, "auto");
  assert.equal(result.kind === "auto" ? result.option.name : "", "日喀则博物馆");
});

test("全部不可用时说明原因并等待用户意见", () => {
  const result = chooseUsablePoiOptions([
    { name: "日喀则博物馆", usable: false, reason: "暂停营业" },
    { name: "日喀则非物质遗产中心", usable: false, reason: "未查到可绑定 POI" },
  ]);
  assert.equal(result.kind, "ask");
  assert.match(result.kind === "ask" ? result.summary : "", /均不可用/);
  assert.match(result.kind === "ask" ? result.summary : "", /暂停营业/);
  assert.match(result.kind === "ask" ? result.summary : "", /未查到可绑定 POI/);
});
