import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const packageJsonPath = path.resolve("package.json");
const pkg = await import(`${packageJsonPath}?t=${Date.now()}`, { with: { type: "json" } });
const version = pkg.default.version;
const remoteHost = process.env.VBK_UPDATE_SSH_HOST || "sx2";
const remoteRoot = process.env.VBK_UPDATE_REMOTE_ROOT || "/data/www/web/downloads/sanrentongyou/updates";
const stableDir = `${remoteRoot}/stable`;
const env = { ...process.env, NODE_OPTIONS: "" };

validateVersion(version);
console.log(`[publish-current-update] package.json version=${version}`);

const existing = [...macArtifacts(version), ...winArtifacts(version)].filter((artifact) => fs.existsSync(artifact));
if (existing.length) {
  console.error(`[publish-current-update] version ${version} already has package artifacts:`);
  for (const artifact of existing) console.error(`[publish-current-update] - ${artifact}`);
  fail("Refusing to rebuild or upload an already packaged version. Bump package.json version first.");
}

if (dryRun) {
  console.log("[publish-current-update] dry run only; no build or upload will run");
  console.log("[publish-current-update] would run:");
  console.log("  npm run check");
  console.log("  npm run package:mac:universal");
  console.log("  npm run package:win");
  console.log("  parallel upload macOS artifacts + Windows artifacts");
  process.exit(0);
}

run("npm", ["run", "check"]);
run("npm", ["run", "package:mac:universal"]);
if (process.platform === "win32") {
  run("npm", ["run", "package:win"]);
} else {
  runWithEnv("npm", ["run", "package:win"], { VBK_ALLOW_CROSS_PACKAGE: "1" });
}

validateMacArtifacts(version);
validateWinArtifacts(version);

await Promise.all([
  uploadArtifactSet("mac", version, [...macArtifacts(version), path.join("release", "latest-mac.yml")], "latest-mac.yml"),
  uploadArtifactSet("win", version, [...winArtifacts(version), path.join("release", "latest.yml")], "latest.yml"),
]);

console.log(`[publish-current-update] published macOS and Windows update version ${version}`);
console.log("[publish-current-update] verify:");
console.log("  curl -fsSL https://www.atdtour.com/downloads/sanrentongyou/updates/stable/latest-mac.yml");
console.log("  curl -fsSL https://www.atdtour.com/downloads/sanrentongyou/updates/stable/latest.yml");

function validateMacArtifacts(version) {
  for (const artifact of macArtifacts(version)) {
    if (!fs.existsSync(artifact)) fail(`Missing macOS artifact after build: ${artifact}`);
  }
  const manifest = fs.readFileSync(path.join("release", "latest-mac.yml"), "utf8");
  if (!new RegExp(`^version:\\s*${escapeRegExp(version)}\\s*$`, "m").test(manifest)) {
    fail(`latest-mac.yml does not declare version ${version}`);
  }
  for (const file of [
    `三人同游-${version}-universal.dmg`,
    `三人同游-${version}-universal.zip`,
  ]) {
    if (!manifest.includes(`url: ${file}`)) fail(`latest-mac.yml does not reference ${file}`);
  }
  if (!/sha512:\s*\S+/.test(manifest)) fail("latest-mac.yml is missing sha512 entries");
}

function validateWinArtifacts(version) {
  for (const artifact of winArtifacts(version)) {
    if (!fs.existsSync(artifact)) fail(`Missing Windows artifact after build: ${artifact}`);
  }
  const manifest = fs.readFileSync(path.join("release", "latest.yml"), "utf8");
  if (!new RegExp(`^version:\\s*${escapeRegExp(version)}\\s*$`, "m").test(manifest)) {
    fail(`latest.yml does not declare version ${version}`);
  }
  const installer = winInstallerName(version);
  if (!manifest.includes(`url: ${installer}`)) fail(`latest.yml does not reference ${installer}`);
  if (!/^path:\s*.+\.exe\s*$/m.test(manifest)) fail("latest.yml must point to the Windows installer exe.");
  if (!/sha512:\s*\S+/.test(manifest)) fail("latest.yml is missing sha512 entries");
}

function macArtifacts(version) {
  return [
    path.join("release", `三人同游-${version}-universal.dmg`),
    path.join("release", `三人同游-${version}-universal.dmg.blockmap`),
    path.join("release", `三人同游-${version}-universal.zip`),
    path.join("release", `三人同游-${version}-universal.zip.blockmap`),
  ];
}

function winArtifacts(version) {
  return [
    path.join("release", winInstallerName(version)),
    path.join("release", `${winInstallerName(version)}.blockmap`),
  ];
}

function winInstallerName(version) {
  return `三人同游-${version}-x64-setup.exe`;
}

async function uploadArtifactSet(platform, version, artifacts, manifestName) {
  const incomingDir = `${remoteRoot}/.incoming/${platform}-${version}-${Date.now()}`;
  const nonManifest = artifacts
    .filter((file) => path.basename(file) !== manifestName)
    .map((file) => path.basename(file));

  await runAsync("ssh", [remoteHost, "mkdir", "-p", shellQuote(incomingDir), shellQuote(stableDir)], platform);
  await runAsync("rsync", ["-av", "--", ...artifacts, `${remoteHost}:${incomingDir}/`], platform);
  for (const file of nonManifest) {
    await runAsync("ssh", [remoteHost, "cp", shellQuote(`${incomingDir}/${file}`), shellQuote(`${stableDir}/${file}`)], platform);
  }
  await runAsync("ssh", [remoteHost, "cp", shellQuote(`${incomingDir}/${manifestName}`), shellQuote(`${stableDir}/${manifestName}`)], platform);
}

function run(command, commandArgs) {
  runWithEnv(command, commandArgs, {});
}

function runWithEnv(command, commandArgs, extraEnv) {
  console.log(`[publish-current-update] ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, {
    env: { ...env, ...extraEnv },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runAsync(command, commandArgs, label) {
  console.log(`[publish-current-update:${label}] ${command} ${commandArgs.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { env, stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} upload command failed: ${command} ${commandArgs.join(" ")}`));
    });
  });
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
  console.error(`[publish-current-update] ${message}`);
  process.exit(1);
}
