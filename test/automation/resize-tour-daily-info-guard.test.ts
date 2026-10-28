import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const SOURCE_ROOT = new URL("../../src/", import.meta.url).pathname;
// VBK 实测：resizeTourDailyInfo="T" 会同时裁剪草稿与正式行程，且不会补回天数。
const FORBIDDEN = /resizeTourDailyInfo\s*:\s*["']T["']/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

test("基本信息保存只允许 resizeTourDailyInfo=F，禁止裁剪正式行程", () => {
  const offenders = sourceFiles(SOURCE_ROOT).filter((path) => FORBIDDEN.test(readFileSync(path, "utf8")));
  assert.deepEqual(offenders, []);
});
