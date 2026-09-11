import { spawnSync } from "node:child_process";
import process from "node:process";

const argsByTarget = {
  all: [],
  "mac:dir": ["--dir", "--mac"],
  "mac:universal": ["--mac", "dmg", "--universal"],
  "mac:x64": ["--mac", "dmg", "--x64"],
  "mac:arm64": ["--mac", "dmg", "--arm64"],
  win: ["--win", "nsis", "--x64"],
  "win:dir": ["--dir", "--win", "--x64"],
};

const target = process.argv[2] ?? "all";
const builderArgs = argsByTarget[target];

if (!builderArgs) {
  console.error(`Unknown package target: ${target}`);
  console.error(`Available targets: ${Object.keys(argsByTarget).join(", ")}`);
  process.exit(1);
}

if (target.startsWith("win") && process.platform !== "win32" && process.env.VBK_ALLOW_CROSS_PACKAGE !== "1") {
  console.error("Windows installers must be built on Windows because better-sqlite3 is a native dependency.");
  console.error("Run this command on a Windows machine, or set VBK_ALLOW_CROSS_PACKAGE=1 to try an unsupported cross-build.");
  process.exit(1);
}

const env = { ...process.env, NODE_OPTIONS: "" };

function run(command, args) {
  const result = spawnSync(command, args, { env, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("npm", ["run", "build"]);
run("electron-builder", builderArgs);
