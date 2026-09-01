import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/renderer/app/views/workspace/review-summary-itinerary-poi.tsx", "utf8");
const stylesSource = readFileSync("src/renderer/app/views/workspace/review-summary-itinerary-poi.module.less", "utf8");
const ipcSource = readFileSync("src/main/ipc/product-ai-ipc.ts", "utf8");

test("行程 POI 编辑器必须通过 VBK suggestPoi 搜索并经 updateReviewField 写回白名单字段", () => {
  assert.match(source, /browser\.suggestPoiDetail\(query/);
  assert.match(source, /products\.updateReviewField\(localProductId,\s*\{\s*field: "itinerarySpotPoi"/s);
  assert.match(source, /dayIndex: item\.dayIndex/);
  assert.match(source, /spotIndex: item\.spotIndex/);
});

test("已匹配 POI 仍保留编辑按钮，并展示候选省市地址", () => {
  assert.match(source, /hasPoi \? formatMatchedPoiLabel\(item\)/);
  assert.match(source, /title=\{`编辑 \$\{item\.title\} 的 VBK POI`\}/);
  assert.match(source, /formatPoiRegion/);
  assert.match(source, /已匹配：\$\{item\.poiName\} · \$\{region\}/);
  assert.match(source, /province: saveTarget\.province/);
  assert.match(source, /city: saveTarget\.city/);
  assert.match(source, /district: saveTarget\.district/);
  assert.match(source, /province: selected\.province \?\? undefined/);
  assert.match(source, /city: selected\.city \?\? undefined/);
  assert.match(source, /district: selected\.district \?\? undefined/);
  assert.doesNotMatch(source, /(province|city|district): selected\.\1 \?\? null/);
  assert.match(source, /地域未知/);
  assert.doesNotMatch(source, /可选择/);
  assert.doesNotMatch(source, /candidate\.poiId \?\? "无 poiId"/);
  // 候选卡片若裁剪溢出，会裁掉省市区域行。
  const resultBlock = stylesSource.match(/\.result\s*\{[^}]*\}/s)?.[0] ?? "";
  assert.match(resultBlock, /\.result\s*\{/);
  assert.doesNotMatch(resultBlock, /overflow\s*:/);
});

test("已匹配文案在有行政区时展示斜杠区域，无行政区时只显示名称", () => {
  assert.match(source, /region \? `已匹配：\$\{item\.poiName\} · \$\{region\}` : `已匹配：\$\{item\.poiName\}`/);
});

test("搜索中输入框仍可编辑，避免映射耗时导致卡住感", () => {
  assert.match(source, /disabled=\{loading === "save"\}/);
  assert.match(source, /正在搜索 VBK POI/);
});

test("行程 POI 搜索成功后展示全部候选并必须先手动选择合法结果", () => {
  assert.equal(source.includes("setSelected(next)"), false);
  assert.match(source, /detail\.candidates\.map\(\(candidate\)/);
  assert.match(source, /setSelected\(candidate\);/);
  assert.match(source, /disabled=\{loading !== null \|\| !selected\?\.selectable\}/);
  assert.doesNotMatch(source, /查看接口详情/);
  assert.doesNotMatch(source, /textFields\.map/);
});

test("POI 保存成功后广播产品更新并退出保存态", () => {
  assert.match(ipcSource, /replaceProductAndSatisfyResearchTasks\([\s\S]*emitProduct\(saved\);[\s\S]*return saved;/);
  assert.match(source, /logPoiManual\("save_success"[\s\S]*setEditing\(false\);[\s\S]*setDetail\(null\);[\s\S]*setSelected\(null\);/);
  assert.match(source, /finally\s*\{\s*setLoading\(null\);\s*\}/);
});

test("无合法 poiName/poiId 的候选只能查看，不能作为保存目标", () => {
  assert.match(source, /data-selectable=\{candidate\.selectable\}/);
  assert.match(source, /disabled=\{!candidate\.selectable \|\| loading !== null\}/);
  assert.match(source, /if \(!selected\?\.selectable \|\| !selected\.poiName \|\| !selected\.poiId \|\| !api\(\)\) return;/);
});

test("已匹配 POI 仍展示编辑按钮，并可继续修改", () => {
  assert.match(source, /hasPoi \? formatMatchedPoiLabel\(item\) : "待手动配置 POI"/);
  assert.match(source, /title=\{`编辑 \$\{item\.title\} 的 VBK POI`\}/);
});

test("点击编辑会立即使用当前 POI 关键词查询", () => {
  assert.match(source, /void searchPoi\(nextKeyword\)/);
  assert.match(source, /const searchPoi = async \(keywordOverride\?: string\)/);
});

test("手动 POI 调试日志必须只在 renderer 开发模式输出，并使用统一前缀", () => {
  assert.match(source, /const POI_MANUAL_LOG_PREFIX = "\[poi\.manual\]"/);
  assert.match(source, /function logPoiManual\(/);
  assert.match(source, /if \(!import\.meta\.env\.DEV\) return;/);
  // logDebug / console.debug 都会被认作可观测日志出口。
  assert.match(source, /(console\.debug|logDebug)\(POI_MANUAL_LOG_PREFIX,\s*event,\s*\{\s*stage: event,\s*\.\.\.context\s*\}\)/);
});

test("手动 POI 调试日志覆盖编辑、搜索、选择和保存链路的安全上下文", () => {
  for (const event of [
    "open_edit",
    "cancel",
    "search_start",
    "search_empty",
    "search_success",
    "search_failure",
    "select_result",
    "save_start",
    "save_success",
    "save_failure",
  ]) {
    assert.match(source, new RegExp(`logPoiManual\\("${event}"`));
  }
  for (const key of ["localProductId", "dayIndex", "spotIndex", "title", "keyword", "poiName", "poiId", "stage"]) {
    assert.match(source, new RegExp(`${key}:`));
  }
  assert.match(source, /browser\.suggestPoiDetail\(query,\s*\{[\s\S]*localProductId,[\s\S]*dayIndex: item\.dayIndex,[\s\S]*spotIndex: item\.spotIndex,[\s\S]*title: item\.title,[\s\S]*\}\)/);
  assert.doesNotMatch(source, /cookie|ticket|Authorization|apiKey|responseText/i);
});
