import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/main/main.ts", "utf8");

function extractHandlerBody(sourceText: string, keyword: string): string {
  const start = sourceText.indexOf(keyword);
  if (start < 0) throw new Error(`keyword not found: ${keyword}`);
  const open = sourceText.indexOf("{", start);
  if (open < 0) throw new Error("opening brace not found");
  let depth = 1;
  let i = open + 1;
  while (i < sourceText.length && depth > 0) {
    const ch = sourceText[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  if (depth !== 0) throw new Error("unbalanced braces");
  if (sourceText.slice(i, i + 2) !== ");") throw new Error("expected handler terminator");
  return sourceText.slice(start, i + 2);
}

test("poi:suggest IPC 调试日志必须由 isDev 保护，并使用统一前缀", () => {
  assert.match(source, /const isDev = !app\.isPackaged/);
  assert.match(source, /function logPoiManualIpc\(/);
  assert.match(source, /if \(!isDev\) return;/);
  // logLog / console.log 都会被认作可观测日志出口。
  assert.match(source, /(console\.log|logLog)\("\[poi\.manual\]",\s*event,\s*\{\s*stage: event,\s*\.\.\.context\s*\}\)/);
});

test("poi:suggest IPC 调试日志覆盖开始、详情、成功、空结果和失败分支", () => {
  const handler = extractHandlerBody(source, 'ipcMain.handle("poi:suggestDetail"');
  for (const event of ["ipc_search_start", "ipc_search_detail", "ipc_search_empty", "ipc_search_success", "ipc_search_failure"]) {
    assert.match(handler, new RegExp(`logPoiManualIpc\\("${event}"`));
  }
  for (const key of ["projectId", "dayIndex", "spotIndex", "title", "keyword"]) {
    assert.match(handler, new RegExp(`${key}:`));
  }
  assert.match(source, /stage: event/);
  assert.match(handler, /const result = await suggestPoiDetailWithRawPayload\(browser, query\)/);
  assert.match(handler, /rawPayload: result\.rawPayload/);
  assert.match(handler, /const \{ rawPayload: _rawPayload, \.\.\.detail \} = result;/);
  assert.match(handler, /return detail;/);
  assert.match(handler, /candidateCount: result\.candidates\.length/);
  assert.match(handler, /poiName: result\.best\.poiName/);
  assert.match(handler, /poiId: result\.best\.poiId/);
  assert.match(handler, /errorMessage:/);
  assert.doesNotMatch(handler, /cookie|ticket|Authorization|apiKey|responseText|requestHeaders/i);
});
