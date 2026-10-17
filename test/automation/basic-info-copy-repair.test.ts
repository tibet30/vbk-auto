import test from "node:test";
import assert from "node:assert/strict";
import {
  parseBasicInfoCopyRejection,
  repairBasicInfoCopy,
  runBasicInfoSaveWithCopyRepair,
} from "../../src/main/automation/automation.main/basic-info-copy-repair.js";

const REAL_FAILURE = "VBK 基本信息保存失败（Ack=Failure）：50016002: 300019:操作说明存在非法关键词：冈仁波齐";

function product(overrides: Record<string, unknown> = {}) {
  return {
    basicInfo: {
      subtitle: "一单一团+24h线上管家｜阿里南线冰川遗址",
      operationNotes: "目的地为拉萨，行程覆盖羊卓雍措、普莫雍措至冈仁波齐、札达土林一线的阿里南线冰川遗址主题。",
      meetingCity: "拉萨",
      ...overrides,
    },
    itinerary: [{ day: 1, title: "第一天" }],
  };
}

function rejectionError(message = REAL_FAILURE) {
  return new Error(message);
}

test("解析平台点名的字段与关键词", () => {
  assert.deepEqual(parseBasicInfoCopyRejection(REAL_FAILURE), { words: ["冈仁波齐"], labels: ["操作说明"] });
  assert.deepEqual(
    parseBasicInfoCopyRejection("VBK 基本信息保存失败（Ack=Failure）：300019:副标题存在非法关键词：祈福、朝圣，请更换或删除非法关键词"),
    { words: ["祈福", "朝圣"], labels: ["副标题"] },
  );
  assert.deepEqual(
    parseBasicInfoCopyRejection("VBK 基本信息保存失败（Ack=Failure）：50016002: 300019:操作说明存在非法关键词：冈仁波齐；副标题存在非法关键词：祈福"),
    { words: ["冈仁波齐", "祈福"], labels: ["操作说明", "副标题"] },
  );
  assert.equal(parseBasicInfoCopyRejection("VBK 基本信息保存失败（Ack=Failure）：40011001: 城市不合法"), undefined);
  assert.equal(parseBasicInfoCopyRejection("VBK 基本信息回读失败（Ack=Failure）：非法关键词：冈仁波齐"), undefined);
  assert.deepEqual(
    parseBasicInfoCopyRejection("VBK 基本信息保存失败（Ack=Success）：300019:操作说明存在非法关键词：国宾"),
    { words: ["国宾"], labels: ["操作说明"] },
  );
});

test("只清理平台点名且本地确实命中的文案字段", () => {
  const value = product();
  const result = repairBasicInfoCopy(value, { words: ["冈仁波齐"], labels: ["操作说明"] });
  assert.deepEqual(result, { changed: ["操作说明删除「冈仁波齐」"], unresolved: [] });
  assert.equal(value.basicInfo.operationNotes.includes("冈仁波齐"), false);
  assert.equal(value.basicInfo.subtitle, "一单一团+24h线上管家｜阿里南线冰川遗址");
  assert.equal(value.basicInfo.meetingCity, "拉萨");
});

test("未点名字段时只在真正命中的字段里清理", () => {
  const value = product({ operationNotes: "运营备注：无特殊说明。" });
  value.basicInfo.subtitle = "祈福主题私家团";
  const result = repairBasicInfoCopy(value, { words: ["祈福", "冈仁波齐"], labels: [] });
  assert.deepEqual(result, { changed: ["副标题删除「祈福」"], unresolved: [] });
  assert.equal(value.basicInfo.subtitle, "主题私家团");
  assert.equal(value.basicInfo.operationNotes, "运营备注：无特殊说明。");
});

test("平台驳回后自动清理命中文案、落库并重试成功", async () => {
  const value = product();
  const logs: string[] = [];
  const learned: any[] = [];
  let saves = 0;
  let persisted = 0;
  const result = await runBasicInfoSaveWithCopyRepair({
    product: value,
    save: async () => {
      saves += 1;
      if (saves === 1) throw rejectionError();
      return { savedWith: "basic-info-api" };
    },
    persist: () => { persisted += 1; },
    log: (message) => { logs.push(message); },
    onLearned: (words, labels, detail) => { learned.push({ words, labels, detail }); },
  });
  assert.deepEqual(result, { savedWith: "basic-info-api" });
  assert.equal(saves, 2);
  assert.equal(persisted, 1);
  assert.equal(value.basicInfo.operationNotes.includes("冈仁波齐"), false);
  assert.deepEqual(learned.map((entry) => [entry.words, entry.labels]), [[["冈仁波齐"], ["操作说明"]]]);
  assert.ok(logs.some((line) => /已清理后重试保存/.test(line)));
});

test("非关键词失败不进入修复，直接上抛", async () => {
  const value = product();
  let persisted = 0;
  await assert.rejects(runBasicInfoSaveWithCopyRepair({
    product: value,
    save: async () => { throw new Error("VBK 基本信息保存失败（Ack=Failure）：40011001: 城市不合法"); },
    persist: () => { persisted += 1; },
    log: () => {},
  }), /城市不合法/);
  assert.equal(persisted, 0);
  assert.equal(value.basicInfo.operationNotes.includes("冈仁波齐"), true);
});

test("命中词不在可清理字段内或预算用尽时如实上抛", async () => {
  const clean = product({ operationNotes: "运营备注：无特殊说明。" });
  await assert.rejects(runBasicInfoSaveWithCopyRepair({
    product: clean,
    save: async () => { throw rejectionError(); },
    persist: () => {},
    log: () => {},
  }), /命中词不在可自动清理的基本信息文案字段内/);

  const value = product();
  const rejected = ["冈仁波齐", "普莫雍措"];
  let saves = 0;
  let persisted = 0;
  const logs: string[] = [];
  await assert.rejects(runBasicInfoSaveWithCopyRepair({
    product: value,
    save: async () => {
      const word = rejected[Math.min(saves, rejected.length - 1)]!;
      saves += 1;
      throw rejectionError(`VBK 基本信息保存失败（Ack=Failure）：300019:操作说明存在非法关键词：${word}`);
    },
    persist: () => { persisted += 1; },
    log: (message) => { logs.push(message); },
    maxRounds: 1,
  }), /普莫雍措/);
  assert.equal(saves, 2);
  assert.equal(persisted, 0);
  assert.equal(value.basicInfo.operationNotes.includes("冈仁波齐"), true);
  assert.ok(logs.some((line) => /已使用 1\/1 轮/.test(line)));
});

test("已学习到的基本信息驳回词在首次保存前就被清理", async () => {
  const value = product();
  let persisted = 0;
  const result = await runBasicInfoSaveWithCopyRepair({
    product: value,
    save: async () => ({ savedWith: "basic-info-api" }),
    persist: () => { persisted += 1; },
    log: () => {},
    knownRejectedWords: ["冈仁波齐"],
  });
  assert.deepEqual(result, { savedWith: "basic-info-api" });
  assert.equal(persisted, 1);
  assert.equal(value.basicInfo.operationNotes.includes("冈仁波齐"), false);
});

test("清理后重试仍失败时不提前落库，并恢复内存中的原文案", async () => {
  const value = product();
  const original = structuredClone(value);
  let saves = 0;
  let persisted = 0;
  await assert.rejects(runBasicInfoSaveWithCopyRepair({
    product: value,
    save: async () => {
      saves += 1;
      if (saves === 1) throw rejectionError();
      throw new Error("VBK 基本信息保存失败（Ack=Failure）：40011001: 二次保存失败");
    },
    persist: () => { persisted += 1; },
    log: () => {},
  }), /二次保存失败/);
  assert.equal(saves, 2);
  assert.equal(persisted, 0);
  assert.deepEqual(value, original);
});
