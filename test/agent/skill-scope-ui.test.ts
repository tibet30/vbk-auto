import assert from "node:assert/strict";
import test from "node:test";
import {
  disabledSkillIds,
  isSkillEnabled,
  nextEnabledSkills,
} from "../../src/renderer/app/views/agent/skill-scope.js";

const all = ["file", "deck", "web"];

test("未设置表示全部启用，停用后变成显式清单", () => {
  assert.equal(isSkillEnabled(undefined, "file"), true);
  assert.deepEqual(disabledSkillIds(all, undefined), []);

  const next = nextEnabledSkills(all, undefined, "file");
  assert.deepEqual(next, ["deck", "web"], "停用一个后应变成显式清单");
  assert.equal(isSkillEnabled(next!, "file"), false);
  assert.deepEqual(disabledSkillIds(all, next!), ["file"]);
});

test("把最后一个停用的重新打开时回到「全部启用」，而不是固化清单", () => {
  const partial = nextEnabledSkills(all, undefined, "file");
  const restored = nextEnabledSkills(all, partial!, "file");
  assert.equal(restored, null, "恢复全部时用 null，避免以后新增 Skill 用不上");
});

test("停用清单里的未知 id 会被过滤，重复打开不会产生重复项", () => {
  const next = nextEnabledSkills(all, ["file", "已删除的 skill"], "deck");
  assert.deepEqual(next, ["file", "deck"], "未知 id 不进入新清单");
  const again = nextEnabledSkills(all, ["file", "deck"], "deck");
  assert.deepEqual(again, ["file"]);
});

test("全部停用是空数组，不是 undefined", () => {
  let current: string[] | undefined = undefined;
  for (const id of all) current = nextEnabledSkills(all, current, id) ?? undefined;
  assert.deepEqual(current, [], "逐个停用后应为空数组（全停）");
  assert.notEqual(current, undefined);
});
