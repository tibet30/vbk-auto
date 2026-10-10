import net from "node:net";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_RENDERER_PORT = 5173;
const MAX_PORT_ATTEMPTS = 100;
const LOOPBACK_HOST = "127.0.0.1";
const WILDCARD_HOST = "0.0.0.0";

// Electron（第三个命令）决定开发会话结果；关闭 App 后的服务清理不算失败。
// 服务或编译器先退出时，-k 会终止 Electron，仍会返回失败。
export const DEV_PROCESS_OPTIONS = ["-k", "--success", "command-2"];

function canListen(port, host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if (error?.code === "EADDRINUSE" || error?.code === "EACCES") resolve(false);
      else reject(error);
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolve(true));
    });
  });
}

export async function findAvailablePort(
  preferredPort = DEFAULT_RENDERER_PORT,
  host = LOOPBACK_HOST,
  maxAttempts = MAX_PORT_ATTEMPTS,
) {
  if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65535) {
    throw new Error(`无效的开发服务端口：${preferredPort}`);
  }

  const lastPort = Math.min(65535, preferredPort + maxAttempts - 1);
  for (let port = preferredPort; port <= lastPort; port += 1) {
    // macOS can admit a loopback listener alongside an existing wildcard
    // listener on the same port. Electron later reaches the wildcard service
    // ambiguously, so the renderer port must be free on both addresses.
    if (await canListen(port, host) && await canListen(port, WILDCARD_HOST)) return port;
  }
  throw new Error(`端口 ${preferredPort}-${lastPort} 均不可用`);
}

function requestedRendererPort() {
  const raw = process.env.VBK_RENDERER_PORT?.trim();
  if (!raw) return DEFAULT_RENDERER_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port)) throw new Error(`VBK_RENDERER_PORT 必须是整数，当前值：${raw}`);
  return port;
}

function shellArgument(value) {
  if (process.platform === "win32") return `"${value.replaceAll("\"", "\"\"")}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function main() {
  const preferredPort = requestedRendererPort();
  const port = await findAvailablePort(preferredPort);
  const rendererUrl = `http://${LOOPBACK_HOST}:${port}`;
  const concurrently = path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "concurrently.cmd" : "concurrently",
  );
  const env = { ...process.env, VBK_RENDERER_URL: rendererUrl };
  const readyDirectory = await mkdir(path.join(os.tmpdir(), "vbk-auto-dev"), { recursive: true })
    .then(() => path.join(os.tmpdir(), "vbk-auto-dev"));
  const mainReadyFile = path.join(readyDirectory, `main-ready-${process.pid}-${Date.now()}.json`);

  if (port === preferredPort) console.log(`[dev] 使用开发服务端口 ${port}`);
  else console.log(`[dev] 端口 ${preferredPort} 已被占用，改用 ${port}`);

  console.log("[dev] 等待本次主进程 watch 编译和模块链接校验");

  const child = spawn(concurrently, [
    ...DEV_PROCESS_OPTIONS,
    `npm run dev:renderer -- --port ${port} --strictPort`,
    `node scripts/dev-main-watch.mjs ${shellArgument(mainReadyFile)}`,
    `wait-on tcp:${LOOPBACK_HOST}:${port} file:${shellArgument(mainReadyFile)} && electron .`,
  ], { stdio: "inherit", env });

  child.once("error", (error) => {
    void rm(mainReadyFile, { force: true });
    console.error("[dev] 启动失败", error);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    void rm(mainReadyFile, { force: true });
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    console.error("[dev] 启动失败", error);
    process.exitCode = 1;
  });
}
