import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const packageJsonPath = path.resolve("package.json");
const pkg = await import(`${packageJsonPath}?t=${Date.now()}`, { with: { type: "json" } });
const version = pkg.default.version;
const remoteHost = process.env.VBK_UPDATE_SSH_HOST || "sx2";
const remoteRoot = process.env.VBK_UPDATE_REMOTE_ROOT || "/data/www/web/downloads/sanrentongyou/updates";
const stableDir = `${remoteRoot}/stable`;
const incomingDir = `${remoteRoot}/.incoming/mac-${version}-${Date.now()}`;
const env = { ...process.env, NODE_OPTIONS: "" };

validateVersion(version);

console.log(`[publish-current-mac-update] package.json version=${version}`);
if (process.platform !== "darwin") {
  fail("macOS update packages must be built on macOS.");
}

const existing = existingVersionArtifacts(version);
if (existing.length) {
  console.error(`[publish-current-mac-update] version ${version} already has package artifacts:`);
  for (const artifact of existing) console.error(`[publish-current-mac-update] - ${artifact}`);
  fail("Refusing to rebuild or upload an already packaged version. Bump package.json version first.");
}

run("npm", ["run", "check"]);
run("npm", ["run", "package:mac:universal"]);
validateArtifacts(version);
uploadArtifacts(version);

console.log(`[publish-current-mac-update] published macOS update version ${version}`);
console.log("[publish-current-mac-update] verify:");
console.log("  curl -fsSL https://www.atdtour.com/downloads/sanrentongyou/updates/stable/latest-mac.yml");

function existingVersionArtifacts(version) {
  return versionArtifacts(version).filter((artifact) => fs.existsSync(artifact));
}

function validateArtifacts(version) {
  for (const artifact of versionArtifacts(version)) {
    if (!fs.existsSync(artifact)) fail(`Missing artifact after build: ${artifact}`);
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

function versionArtifacts(version) {
  return [
    path.join("release", `三人同游-${version}-universal.dmg`),
    path.join("release", `三人同游-${version}-universal.dmg.blockmap`),
    path.join("release", `三人同游-${version}-universal.zip`),
    path.join("release", `三人同游-${version}-universal.zip.blockmap`),
  ];
}

function uploadArtifacts(version) {
  const artifacts = [...versionArtifacts(version), path.join("release", "latest-mac.yml")];
  run("ssh", [remoteHost, "mkdir", "-p", shellQuote(incomingDir), shellQuote(stableDir)]);
  run("rsync", ["-av", "--", ...artifacts, `${remoteHost}:${incomingDir}/`]);

  const nonManifest = artifacts
    .filter((file) => path.basename(file) !== "latest-mac.yml")
    .map((file) => path.basename(file));
  for (const file of nonManifest) {
    run("ssh", [remoteHost, "cp", shellQuote(`${incomingDir}/${file}`), shellQuote(`${stableDir}/${file}`)]);
  }
  run("ssh", [remoteHost, "cp", shellQuote(`${incomingDir}/latest-mac.yml`), shellQuote(`${stableDir}/latest-mac.yml`)]);
}

function run(command, commandArgs) {
  console.log(`[publish-current-mac-update] ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, { env, stdio: "inherit", shell: false });
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
  console.error(`[publish-current-mac-update] ${message}`);
  process.exit(1);
}
