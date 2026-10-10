import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { DEV_PROCESS_OPTIONS } from "../../scripts/dev.mjs";

function command(code?: number) {
  const source = code === undefined
    ? "setInterval(() => {}, 1000)"
    : `setTimeout(() => process.exit(${code}), 150)`;
  return `"${process.execPath}" -e "${source}"`;
}

async function runSession(exitCodes: Array<number | undefined>) {
  const runner = path.resolve("node_modules/concurrently/dist/bin/index.js");
  const child = spawn(process.execPath, [runner, ...DEV_PROCESS_OPTIONS, ...exitCodes.map(command)], {
    stdio: "ignore",
  });
  return await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

test("正常关闭 Electron 后清理开发服务，整次会话成功", { timeout: 10000 }, async () => {
  assert.equal(await runSession([undefined, undefined, 0]), 0);
});

for (const [name, exits] of [
  ["Electron 异常退出", [undefined, undefined, 1]],
  ["渲染器启动失败", [1, undefined, undefined]],
  ["主进程编译失败", [undefined, 1, undefined]],
  ["编译监听意外正常结束", [undefined, 0, undefined]],
] as const) {
  test(`${name}仍返回失败`, { timeout: 10000 }, async () => {
    assert.notEqual(await runSession([...exits]), 0);
  });
}
