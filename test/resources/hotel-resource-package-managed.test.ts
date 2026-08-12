import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyPackageManagedSegments } from "../../src/main/automation/ctrip/resources.js";

describe("classifyPackageManagedSegments 纯函数分支覆盖", () => {
  test("全正住宿段且都带 enabled package → ok=true 并保留原 segments", () => {
    const items = [
      { title: "Day1 厦门 1晚", nights: 1, hasEnabledPackage: true },
      { title: "Day3 厦门 1晚", nights: 1, hasEnabledPackage: true },
    ];
    const result = classifyPackageManagedSegments(items);
    assert.equal(result.ok, true);
    assert.equal(result.segments, items);
    assert.equal(result.segments.length, 2);
  });

  test("混合正住宿段（nights>0 与 nights=0）时仍按正住宿段判定", () => {
    const items = [
      { title: "Day1 用车段", nights: 0, hasEnabledPackage: false },
      { title: "Day2 含住宿", nights: 2, hasEnabledPackage: true },
    ];
    const result = classifyPackageManagedSegments(items);
    assert.equal(result.ok, true);
    assert.equal(result.segments, items);
  });

  test("无任何正住宿段（全部 nights=0）→ ok=false reason=no-lodging", () => {
    const items = [
      { title: "Day1 用车段", nights: 0, hasEnabledPackage: false },
      { title: "Day2 用车段", nights: 0, hasEnabledPackage: true },
    ];
    assert.deepEqual(classifyPackageManagedSegments(items), { ok: false, reason: "no-lodging" });
  });

  test("空数组 / undefined / null 都归一为 no-lodging", () => {
    assert.deepEqual(classifyPackageManagedSegments([]), { ok: false, reason: "no-lodging" });
    assert.deepEqual(
      classifyPackageManagedSegments(undefined as unknown as never[]),
      { ok: false, reason: "no-lodging" },
    );
    assert.deepEqual(
      classifyPackageManagedSegments(null as unknown as never[]),
      { ok: false, reason: "no-lodging" },
    );
  });

  test("任一正住宿段缺 enabled package → ok=false reason=missing-package 并列出 missing", () => {
    const items = [
      { title: "Day2 含住宿", nights: 2, hasEnabledPackage: true },
      { title: "Day3 含住宿但无套餐", nights: 1, hasEnabledPackage: false },
    ];
    const result = classifyPackageManagedSegments(items);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing-package");
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0].title, "Day3 含住宿但无套餐");
    assert.equal(result.missing[0].nights, 1);
  });

  test("多个正住宿段都缺 enabled package → missing 列表全部返回", () => {
    const items = [
      { title: "Day2", nights: 2, hasEnabledPackage: false },
      { title: "Day3", nights: 1, hasEnabledPackage: false },
    ];
    const result = classifyPackageManagedSegments(items);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing-package");
    assert.equal(result.missing.length, 2);
  });

  test("hasEnabledPackage===undefined（既非 true 也非 false）按缺套餐处理", () => {
    const items = [{ title: "Day2", nights: 2, hasEnabledPackage: undefined }];
    const result = classifyPackageManagedSegments(items);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing-package");
  });

  test("nights 为字符串数字时仍按 Number>0 判定", () => {
    const items = [{ title: "Day1", nights: "2" as unknown as number, hasEnabledPackage: true }];
    const result = classifyPackageManagedSegments(items);
    assert.equal(result.ok, true);
  });
});

describe("ensureHotelResource hotelEntryCount 分支锁定", () => {
  const src = readFileSync("src/main/automation/ctrip/resources.ts", "utf8");

  test("===1 分支仍执行 click() + waitForURL(/newResourceRuleEdit)", () => {
    // ===1 必须保持原 click 流程：跳进 newResourceRuleEdit 后继续走「添加酒店」弹窗。
    // 直接酒店入口存在时不允许走「套餐承载住宿」skipped 分支。
    assert.match(src, /hotelEntries\.first\(\)\.click\(\)/);
    assert.ok(
      src.includes("newResourceRuleEdit") && src.includes("resourcetype=hotel"),
      "should keep waitForURL(/newResourceRuleEdit?resourcetype=hotel/i)",
    );
    // ===0 分支（package-managed）必须独立于 click 流程，不能跨界执行 click / waitForURL。
    const zeroBranch = src.match(/if \(hotelEntryCount === 0\) \{[\s\S]*?\n {2}\}/);
    assert.ok(zeroBranch, "should declare ===0 branch");
    assert.doesNotMatch(zeroBranch[0], /hotelEntries\.first\(\)\.click\(\)/);
    assert.ok(!zeroBranch[0].includes("newResourceRuleEdit"));
    // ===0 成功 return 必带 packageManaged:true（这是唯一允许出现 packageManaged 的位置）
    assert.match(zeroBranch[0], /packageManaged:\s*true/);
    // click 路径（===1）位于 ===0 块之后；同样不允许出现 packageManaged / 套餐承载住宿。
    const clickPath = src.split(zeroBranch[0])[1] ?? "";
    assert.ok(clickPath.includes("hotelEntries.first().click()"));
    assert.ok(!clickPath.includes("packageManaged"));
    assert.ok(!clickPath.includes("住宿由已配置套餐资源承载"));
  });

  test("===0 成功分支返回 packageManaged:true + skipped 文案，===1 不允许走该分支", () => {
    assert.match(src, /套餐资源承载住宿，无独立酒店入口/);
    assert.match(src, /packageManaged:\s*true/);
    // ===0 成功分支不应该 click() / waitForURL（避免「无独立入口」误进 newResourceRuleEdit）
    const zeroBranch = src.match(/if \(hotelEntryCount === 0\) \{[\s\S]*?\n {2}\}/);
    assert.ok(zeroBranch);
    assert.doesNotMatch(zeroBranch[0], /hotelEntries\.first\(\)\.click\(\)/);
  });

  test(">1 分支抛「可配置酒店的住宿行程段数量异常」原错误", () => {
    assert.match(src, /hotelEntryCount > 1/);
    assert.match(src, /可配置酒店的住宿行程段数量异常：期望 1，实际/);
  });

  test("ensureHotelResource 中调用 classifyPackageManagedSegments 纯函数判定", () => {
    // DOM 抽取结果先 map 成 { title, nights, hasEnabledPackage } 的纯函数契约 (pureItems),
    // 再灌入 classifyPackageManagedSegments，避免直接灌 DOM 字段名。
    assert.match(src, /classifyPackageManagedSegments\(pureItems\)/);
    // pureItems 映射必须显式给出 nights / hasEnabledPackage 字段来源。
    assert.match(src, /nights:\s*seg\.stayNights/);
    assert.match(src, /hasEnabledPackage:\s*seg\.enabledPackageCount\s*>\s*0/);
  });

  test("evaluateAll 抽取项满足 items 契约：title / stayNights / packageItemCount / enabledPackageCount", () => {
    const block = src.match(/evaluateAll\(\(nodes\)[\s\S]*?\}\)/);
    assert.ok(block, "should evaluateAll on .ResourceConfig-content-card");
    assert.ok(
      block[0].includes("住宿晚数") && block[0].includes("(\\d+)"),
      "should parse nights from \"住宿晚数\" + digits in evaluateAll",
    );
    // evaluateAll 直接返回 DOM 抽取字段：stayNights / packageItemCount / enabledPackageCount，
    // hasEnabledPackage 是 pureItems 派生字段，不应在 evaluateAll 块内。
    assert.ok(block[0].includes("stayNights"));
    assert.ok(block[0].includes("packageItemCount"));
    assert.ok(block[0].includes("enabledPackageCount"));
    assert.ok(block[0].includes("disacitve"));
    assert.ok(
      !block[0].includes("hasEnabledPackage"),
      "hasEnabledPackage must be derived in pureItems map, not inside evaluateAll",
    );
  });
});