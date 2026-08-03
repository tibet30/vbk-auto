import { spawn } from "node:child_process";
import electron from "electron";

const child = spawn(electron, ["."], {
  stdio: "inherit",
  env: process.env,
});

let stopping = false;

function shutdown(signal) {
  if (stopping) return;
  stopping = true;

  if (child.exitCode !== null || child.signalCode !== null) {
    process.exit(0);
  }

  child.once("exit", () => process.exit(0));
  child.kill(signal);

  // Electron should stop promptly. Do not let a stuck child block watch-mode
  // restarts forever during development.
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

child.once("exit", (code, signal) => {
  if (stopping) return;
  process.exitCode = code ?? (signal ? 1 : 0);
});
