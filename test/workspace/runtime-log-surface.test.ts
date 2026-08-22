import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

test("侧栏公开运行日志入口，页面提供实时刷新、完整筛选和当前结果导出", () => {
  const rail = read("src/renderer/app/views/shell/Rail.tsx");
  const page = read("src/renderer/app/views/operation-log/index.tsx");
  assert.match(rail, /setView\("operation-log"\)/);
  assert.match(rail, /aria-label="运行日志"/);
  assert.match(page, /导出当前结果/);
  assert.match(page, /2_500/);
  for (const label of ["级别", "来源", "类型", "状态", "阶段"]) assert.match(page, new RegExp(`label="${label}"`));
});

test("preload 只暴露受限日志读取、捕获和导出 IPC，不提供数据库或文件直通", () => {
  const preload = read("src/main/preload.cts");
  const contracts = read("src/shared/contracts-api.ts");
  assert.match(preload, /operationLog:load/);
  assert.match(preload, /operationLog:capture/);
  assert.match(preload, /operationLog:export/);
  assert.match(contracts, /capture\(input: RuntimeLogCaptureInput\): Promise<void>/);
  assert.match(contracts, /export\(query\?: OperationLogQuery\): Promise<OperationLogExportResult>/);
  assert.doesNotMatch(preload, /operationLog:[\s\S]{0,500}(?:database|writeFile|readFile)/i);
});
