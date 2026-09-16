import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const args = process.argv.slice(2);
const confirmed = args.includes("--confirm");
const explicitVersion = args.find((arg) => !arg.startsWith("--"));
const packageJsonPath = path.resolve("package.json");
const pkg = await import(`${packageJsonPath}?t=${Date.now()}`, { with: { type: "json" } });
const version = explicitVersion ?? pkg.default.version;
const remoteHost = process.env.VBK_UPDATE_SSH_HOST || "sx2";
const remoteRoot = process.env.VBK_UPDATE_REMOTE_ROOT || "/data/www/web/downloads/sanrentongyou/updates";
const stableDir = `${remoteRoot}/stable`;
const incomingDir = `${remoteRoot}/.incoming/mac-${version}-${Date.now()}`;
const env = { ...process.env, NODE_OPTIONS: "" };

validateVersion(version);
const artifacts = macArtifacts(version);
validateArtifacts(version, artifacts);

if (!confirmed) {
  console.log("[upload-mac-update] dry run only; add --confirm to upload");
  console.log(`[upload-mac-update] host: ${remoteHost}`);
  console.log(`[upload-mac-update] stable: ${stableDir}`);
  for (const artifact of artifacts) console.log(`[upload-mac-update] - ${artifact}`);
  process.exit(0);
}

run("ssh", [remoteHost, "mkdir", "-p", shellQuote(incomingDir), shellQuote(stableDir)]);
run("rsync", ["-av", "--", ...artifacts, `${remoteHost}:${incomingDir}/`]);

const nonManifest = artifacts
  .filter((file) => path.basename(file) !== "latest-mac.yml")
  .map((file) => path.basename(file));
for (const file of nonManifest) {
  run("ssh", [remoteHost, "cp", shellQuote(`${incomingDir}/${file}`), shellQuote(`${stableDir}/${file}`)]);
}
run("ssh", [remoteHost, "cp", shellQuote(`${incomingDir}/latest-mac.yml`), shellQuote(`${stableDir}/latest-mac.yml`)]);

console.log(`[upload-mac-update] uploaded macOS ${version} update files to ${remoteHost}:${stableDir}`);
console.log("[upload-mac-update] verify:");
console.log("  curl -fsSL https://www.atdtour.com/downloads/sanrentongyou/updates/stable/latest-mac.yml");

function macArtifacts(version) {
  return [
    path.join("release", `三人同游-${version}-universal.dmg`),
    path.join("release", `三人同游-${version}-universal.dmg.blockmap`),
    path.join("release", `三人同游-${version}-universal.zip`),
    path.join("release", `三人同游-${version}-universal.zip.blockmap`),
    path.join("release", "latest-mac.yml"),
  ];
}

function validateArtifacts(version, artifacts) {
  for (const artifact of artifacts) {
    if (!fs.existsSync(artifact)) fail(`Missing artifact: ${artifact}`);
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

function run(command, args) {
  console.log(`[upload-mac-update] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { env, stdio: "inherit", shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function validateVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`Version must use x.y.z format, got: ${version}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(message) {
  console.error(`[upload-mac-update] ${message}`);
  process.exit(1);
}
