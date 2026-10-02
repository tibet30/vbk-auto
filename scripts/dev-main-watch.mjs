import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const WATCH_SUCCESS = /Found 0 errors\. Watching for file changes\./;
const MAIN_ENTRY = path.join(process.cwd(), "dist-electron", "main", "agent", "integration.js");

export function createWatchReadyGate({ verify, markReady }) {
  let output = "";
  let released = false;
  return async (chunk) => {
    if (released) return;
    output = `${output}${chunk}`.slice(-512);
    if (!WATCH_SUCCESS.test(output)) return;
    released = true;
    await verify();
    await markReady();
  };
}

export async function verifyMainModuleLink(entry = MAIN_ENTRY) {
  await import(`${pathToFileURL(entry).href}?dev-ready=${Date.now()}`);
}

async function main() {
  const readyFile = process.argv[2];
  if (!readyFile) throw new Error("缺少主进程就绪标记路径");
  await rm(readyFile, { force: true });
  const compiler = path.join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
  const child = spawn(process.execPath, [compiler, "--watch", "--pretty", "false"], { stdio: ["ignore", "pipe", "pipe"] });
  let failed = false;
  let stopping = false;
  const fail = (error) => {
    if (failed) return;
    failed = true;
    console.error("[dev] 主进程编译或模块链接校验失败", error);
    child.kill();
    process.exitCode = 1;
  };
  const markReady = async () => {
    const pendingFile = `${readyFile}.${process.pid}.tmp`;
    await writeFile(pendingFile, `${JSON.stringify({ pid: process.pid, readyAt: new Date().toISOString() })}\n`);
    await rename(pendingFile, readyFile);
    console.log("[dev] 主进程 watch 编译及模块链接校验已完成");
  };
  const gate = createWatchReadyGate({ verify: verifyMainModuleLink, markReady });
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    void gate(String(chunk)).catch(fail);
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.once("error", fail);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      stopping = true;
      child.kill(signal);
    });
  }
  child.once("exit", (code, signal) => {
    if (!failed && !stopping && code !== 0) fail(new Error(`主进程 watch 已退出（退出码：${code ?? "无"}${signal ? `，信号：${signal}` : ""}）`));
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    console.error("[dev] 主进程 watch 启动失败", error);
    process.exitCode = 1;
  });
}
