import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const packageJsonPath = path.resolve("package.json");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const pkg = await import(`${packageJsonPath}?t=${Date.now()}`, { with: { type: "json" } });
const version = pkg.default.version;
const remoteHost = process.env.VBK_UPDATE_SSH_HOST || "sx2";
const remoteRoot = process.env.VBK_UPDATE_REMOTE_ROOT || "/data/www/web/downloads/sanrentongyou/updates";
const stableDir = `${remoteRoot}/stable`;
const incomingDir = `${remoteRoot}/.incoming/win-${version}-${Date.now()}`;
const env = { ...process.env, NODE_OPTIONS: "" };

validateVersion(version);

console.log(`[publish-current-win-update] package.json version=${version}`);
const existing = existingVersionArtifacts(version);
if (existing.length) {
  console.error(`[publish-current-win-update] version ${version} already has Windows package artifacts:`);
  for (const artifact of existing) console.error(`[publish-current-win-update] - ${artifact}`);
  fail("Refusing to rebuild or upload an already packaged version. Bump package.json version first.");
}

if (dryRun) {
  console.log("[publish-current-win-update] dry run only; no build or upload will run");
  console.log("[publish-current-win-update] would run:");
  console.log("  npm run check");
  console.log("  npm run package:win");
  console.log(`  upload release/${windowsInstallerName(version)}, blockmap, and release/latest.yml`);
  process.exit(0);
}

run("npm", ["run", "check"]);
if (process.platform === "win32") {
  run("npm", ["run", "package:win"]);
} else {
  runWithEnv("npm", ["run", "package:win"], { VBK_ALLOW_CROSS_PACKAGE: "1" });
}
validateArtifacts(version);
uploadArtifacts(version);

console.log(`[publish-current-win-update] published Windows update version ${version}`);
console.log("[publish-current-win-update] verify:");
console.log("  curl -fsSL https://www.atdtour.com/downloads/sanrentongyou/updates/stable/latest.yml");

function existingVersionArtifacts(version) {
  return versionArtifacts(version).filter((artifact) => fs.existsSync(artifact));
}

function validateArtifacts(version) {
  for (const artifact of versionArtifacts(version)) {
    if (!fs.existsSync(artifact)) fail(`Missing artifact after build: ${artifact}`);
  }
  const manifest = fs.readFileSync(path.join("release", "latest.yml"), "utf8");
  if (!new RegExp(`^version:\\s*${escapeRegExp(version)}\\s*$`, "m").test(manifest)) {
    fail(`latest.yml does not declare version ${version}`);
  }
  const installer = windowsInstallerName(version);
  if (!manifest.includes(`url: ${installer}`)) fail(`latest.yml does not reference ${installer}`);
  if (!/^path:\s*.+\.exe\s*$/m.test(manifest)) fail("latest.yml must point to the Windows installer exe.");
  if (!/sha512:\s*\S+/.test(manifest)) fail("latest.yml is missing sha512 entries");
}

function versionArtifacts(version) {
  return [
    path.join("release", windowsInstallerName(version)),
    path.join("release", `${windowsInstallerName(version)}.blockmap`),
  ];
}

function windowsInstallerName(version) {
  return `三人同游-${version}-x64-setup.exe`;
}

function uploadArtifacts(version) {
  const artifacts = [...versionArtifacts(version), path.join("release", "latest.yml")];
  run("ssh", [remoteHost, "mkdir", "-p", shellQuote(incomingDir), shellQuote(stableDir)]);
  run("rsync", ["-av", "--", ...artifacts, `${remoteHost}:${incomingDir}/`]);

  const nonManifest = artifacts
    .filter((file) => path.basename(file) !== "latest.yml")
    .map((file) => path.basename(file));
  for (const file of nonManifest) {
    run("ssh", [remoteHost, "cp", shellQuote(`${incomingDir}/${file}`), shellQuote(`${stableDir}/${file}`)]);
  }
  run("ssh", [remoteHost, "cp", shellQuote(`${incomingDir}/latest.yml`), shellQuote(`${stableDir}/latest.yml`)]);
}

function run(command, commandArgs) {
  runWithEnv(command, commandArgs, {});
}

function runWithEnv(command, commandArgs, extraEnv) {
  console.log(`[publish-current-win-update] ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, {
    env: { ...env, ...extraEnv },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function validateVersion(value) {
  if (!/^\d+\.\d+\.\d+$/.test(value)) fail(`Version must use x.y.z format, got: ${value}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(message) {
  console.error(`[publish-current-win-update] ${message}`);
  process.exit(1);
}
