import assert from "node:assert/strict";
import test from "node:test";
import { isUnpublishedActive } from "../../src/shared/vbk-publication.js";
import { assertRemoteDraftCanBeReplaced } from "../../src/main/automation/automation.main/automation.main.replace-locked-draft.js";

test("首次保存基本信息后 active=D（无效·下线）仍视为未发布", () => {
  assert.equal(isUnpublishedActive("F"), true);
  assert.equal(isUnpublishedActive("D"), true);
  assert.equal(isUnpublishedActive("T"), false);
  assert.equal(isUnpublishedActive(""), false);
  assert.equal(isUnpublishedActive(undefined), false);
});

test("替代草稿核验接受 active=D 的未提审草稿，已发布仍拒绝", () => {
  const remote = (active: string, releaseActive = "F") => ({ data: {
    saleControlInfo: { productCategoryID: 10 },
    baseInfo: { active },
    meta: { auditStatus: "N", releaseActive },
  } });
  assert.doesNotThrow(() => assertRemoteDraftCanBeReplaced(remote("D")));
  assert.doesNotThrow(() => assertRemoteDraftCanBeReplaced(remote("F")));
  assert.throws(() => assertRemoteDraftCanBeReplaced(remote("T")), /不满足安全替代条件/);
  assert.throws(() => assertRemoteDraftCanBeReplaced(remote("D", "T")), /不满足安全替代条件/);
});
