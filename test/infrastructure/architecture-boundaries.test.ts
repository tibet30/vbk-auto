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
  assert.match(source("src/main/planning/schemas.ts"), /from\s+["']\.\/stage-contract\.js["']/);
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
  const registrars = [
    "src/main/ipc/product-ai-ipc.ts",
    "src/main/ipc/planning-ipc.ts",
    "src/main/ipc/browser-automation-ipc.ts",
    "src/main/ipc/settings-ipc.ts",
  ];
  for (const path of registrars) {
    const content = source(path);
    assert.match(content, /import \{ secureIpcMain as ipcMain \} from ["'][^"']*ipc-sender\.js["']/,
      `${path} 必须使用统一安全 IPC 门面`);
    assert.doesNotMatch(content, /import \{[^}]*\bipcMain\b[^}]*\} from ["']electron["']/,
      `${path} 不得绕过安全门面直接导入 electron.ipcMain`);
  }
});
