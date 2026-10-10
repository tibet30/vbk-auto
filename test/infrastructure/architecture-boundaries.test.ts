import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");

function typescriptFiles(directory: string): string[] {
  const absolute = resolve(ROOT, directory);
  return readdirSync(absolute).flatMap((entry) => {
    const path = join(absolute, entry);
    return statSync(path).isDirectory()
      ? typescriptFiles(relative(ROOT, path))
      : path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

test("planning 与 data 不得反向依赖 automation 工作流层", () => {
  const violations = [...typescriptFiles("src/main/planning"), ...typescriptFiles("src/main/data")]
    .filter((path) => /from\s+["'][^"']*automation\//.test(readFileSync(path, "utf8")))
    .map((path) => relative(ROOT, path));

  assert.deepEqual(violations, []);
});

test("planning schema 与工具 schema 通过 stage-contract 单向共享阶段白名单", () => {
  assert.doesNotMatch(source("src/main/planning/tool-schema.ts"), /from\s+["']\.\/schemas\.js["']/);
  assert.doesNotMatch(source("src/main/planning/schemas.ts"), /from\s+["']\.\/tool-schema\.js["']/);
  assert.match(source("src/main/planning/tool-schema.ts"), /from\s+["']\.\/stage-contract\.js["']/);
  // After split, schemas.ts is a barrel; concrete stage-contract imports live
  // in schemas/{validate,system-prompt}.ts. Verify one of them uses stage-contract.
  const subSchemaSrc = [
    source("src/main/planning/schemas.ts"),
    source("src/main/planning/schemas/validate.ts"),
    source("src/main/planning/schemas/system-prompt.ts"),
  ].join("\n");
  assert.match(subSchemaSrc, /from\s+["']\.{1,2}\/stage-contract\.js["']/);
});

test("跨工作流产品分类契约只有一个领域定义源", () => {
  const definition = source("src/main/domain/product/recommendation-categories.ts");
  assert.match(definition, /export const RECOMMENDATION_CATEGORIES = \[/);
  assert.match(definition, /export const VBK_RECOMMENDATION_CATEGORIES = RECOMMENDATION_CATEGORIES/);

  const schema = source("src/main/automation/schema/schema-definitions.ts");
  assert.doesNotMatch(schema, /export const RECOMMENDATION_CATEGORIES = \[/);
  assert.match(schema, /from\s+["']\.\.\/\.\.\/domain\/product\/recommendation-categories\.js["']/);
});

test("所有业务 IPC registrar 统一通过 secureIpcMain 注册", () => {
  // After splitting, some registrars are barrels that delegate to sub-files.
  // The test now reads both the registrar path and any planning-ipc/* siblings.
  const registrars = [
    ["src/main/ipc/product-ai-ipc.ts"],
    [
      "src/main/ipc/planning-ipc.ts",
      "src/main/ipc/planning-ipc/ipc-handlers.ts",
      "src/main/ipc/planning-ipc/run-planning.ts",
      "src/main/ipc/planning-ipc/preflight-failure.ts",
    ],
    ["src/main/ipc/browser-automation-ipc.ts"],
    ["src/main/ipc/settings-ipc.ts"],
  ];
  for (const group of registrars) {
    const combined = group.map(source).join("\n");
    const label = group[0];
    assert.match(combined, /import \{ secureIpcMain as ipcMain \} from ["'][^"']*ipc-sender\.js["']/,
      `${label} 必须使用统一安全 IPC 门面`);
    assert.doesNotMatch(combined, /import \{[^}]*\bipcMain\b[^}]*\} from ["']electron["']/,
      `${label} 不得绕过安全门面直接导入 electron.ipcMain`);
  }
});

test("会置换 VBK 页面的登录/导航 IPC 必须先检查页面占用", () => {
  const content = source("src/main/ipc/browser-automation-ipc.ts");
  for (const channel of ["browser:login", "browser:logout", "browser:navigate", "browser:addLogin", "browser:switchAccount"]) {
    const start = content.indexOf(`ipcMain.handle("${channel}"`);
    assert.notEqual(start, -1, `${channel} 必须存在`);
    const block = content.slice(start, start + 400);
    assert.match(block, /assertVbkPageIdle/, `${channel} 必须在占用检查后再置换页面`);
  }
  const statusStart = content.indexOf(`ipcMain.handle("browser:status"`);
  const statusBlock = content.slice(statusStart, statusStart + 400);
  assert.doesNotMatch(statusBlock, /assertVbkPageIdle/, "browser:status 只读，不能因占用而失败");
});
