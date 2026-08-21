import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_RENDERER_PORT = 5173;
const MAX_PORT_ATTEMPTS = 100;
const LOOPBACK_HOST = "127.0.0.1";

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
    if (await canListen(port, host)) return port;
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

  if (port === preferredPort) console.log(`[dev] 使用开发服务端口 ${port}`);
  else console.log(`[dev] 端口 ${preferredPort} 已被占用，改用 ${port}`);

  const child = spawn(concurrently, [
    "-k",
    `npm run dev:renderer -- --port ${port} --strictPort`,
    "npm run dev:main",
    `wait-on tcp:${LOOPBACK_HOST}:${port} file:dist-electron/main/main.js && electron .`,
  ], { stdio: "inherit", env });

  child.once("error", (error) => {
    console.error("[dev] 启动失败", error);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
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
