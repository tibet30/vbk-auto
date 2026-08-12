import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/renderer/app/views/workspace/review-summary-itinerary-poi.tsx", "utf8");

test("行程 POI 编辑器必须通过 VBK suggestPoi 搜索并经 updateReviewField 写回白名单字段", () => {
  assert.match(source, /browser\.suggestPoiDetail\(query/);
  assert.match(source, /projects\.updateReviewField\(projectId,\s*\{\s*field: "itinerarySpotPoi"/s);
  assert.match(source, /dayIndex: item\.dayIndex/);
  assert.match(source, /spotIndex: item\.spotIndex/);
});

test("行程 POI 搜索成功后展示全部候选并必须先手动选择合法结果", () => {
  assert.equal(source.includes("setSelected(next)"), false);
  assert.match(source, /detail\.candidates\.map\(\(candidate\)/);
  assert.match(source, /candidate\.textFields\.map\(\(field\)/);
  assert.match(source, /<b>\{field\.path\}：<\/b>\{field\.value\}/);
  assert.match(source, /setSelected\(candidate\);/);
  assert.match(source, /disabled=\{loading !== null \|\| !selected\?\.selectable\}/);
});

test("无合法 poiName/poiId 的候选只能查看，不能作为保存目标", () => {
  assert.match(source, /data-selectable=\{candidate\.selectable\}/);
  assert.match(source, /disabled=\{!candidate\.selectable \|\| loading !== null\}/);
  assert.match(source, /\{candidate\.selectable \? "可选择" : "仅查看"\}/);
  assert.match(source, /if \(!selected\?\.selectable \|\| !selected\.poiName \|\| !selected\.poiId \|\| !api\(\)\) return;/);
});

test("已匹配 POI 只展示状态，不展示编辑按钮", () => {
  assert.match(source, /\{hasPoi \? `已匹配：\$\{item\.poiName\}（\$\{item\.poiId\}）` : "待核查 POI"\}/);
  assert.match(source, /\{!hasPoi && \(/);
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
  for (const key of ["projectId", "dayIndex", "spotIndex", "title", "keyword", "poiName", "poiId", "stage"]) {
    assert.match(source, new RegExp(`${key}:`));
  }
  assert.match(source, /browser\.suggestPoiDetail\(query,\s*\{[\s\S]*projectId,[\s\S]*dayIndex: item\.dayIndex,[\s\S]*spotIndex: item\.spotIndex,[\s\S]*title: item\.title,[\s\S]*\}\)/);
  assert.doesNotMatch(source, /cookie|ticket|Authorization|apiKey|responseText/i);
});
