/**
 * 待处理事项里的 schema 校验错误必须是中文：字段名走中文标签，说明不带 zod 英文原文；
 * 与自动录入契约重复的字段（副标题 / 省份 / 运营备注 / 每日行程）不再额外出现一条英文项。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computeReadiness } from "../../src/main/readiness.js";
import { schemaIssueToReadinessIssue, schemaPathLabel } from "../../src/main/readiness-schema-issues.js";

test("路径翻译成中文字段名", () => {
  assert.equal(schemaPathLabel(["basicInfo", "meetingCity"]), "基本信息 · 集合城市");
  assert.equal(schemaPathLabel(["itinerary", 1, "title"]), "每日行程 · 第 2 天 · 标题");
  assert.equal(schemaPathLabel(["presentation", "cover", "sizeBytes"]), "展示信息 · 产品封面 · 文件大小");
  assert.equal(schemaPathLabel([]), "产品方案");
});

test("zod 英文 message 被替换为中文说明", () => {
  const issue = schemaIssueToReadinessIssue({
    code: "too_small", path: ["basicInfo", "meetingCity"], origin: "string", minimum: 1, inclusive: true,
    message: "Too small: expected string to have >=1 characters",
  });
  assert.equal(issue.label, "基本信息 · 集合城市");
  assert.match(issue.detail, /至少需要 1 个字符/);
  assert.doesNotMatch(issue.detail, /[A-Za-z]{4,}/);
});

test("空产品的待处理事项不含英文校验原文，且契约已覆盖的字段不重复", () => {
  const { issues } = computeReadiness({ product: { basicInfo: { days: 7, nights: 6 }, itinerary: [] }, researchTasks: [] });
  for (const issue of issues) {
    assert.doesNotMatch(`${issue.label} ${issue.detail}`, /Too small|expected|Invalid input|basicInfo\.|^itinerary$/);
  }
  assert.equal(issues.filter((issue) => issue.label === "副标题").length, 1);
  assert.equal(issues.filter((issue) => issue.label === "每日行程").length, 1);
});
