import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const packageJsonPath = path.resolve("package.json");
const pkg = await import(`${packageJsonPath}?t=${Date.now()}`, { with: { type: "json" } });
const version = pkg.default.version;
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

if (dryRun) {
  console.log("[publish-current-mac-update] dry run only; no build or upload will run");
  console.log("[publish-current-mac-update] would run:");
  console.log("  npm run check");
  console.log("  npm run package:mac:universal");
  console.log(`  npm run release:upload-online:mac -- ${version} --confirm`);
  process.exit(0);
}

run("npm", ["run", "check"]);
run("npm", ["run", "package:mac:universal"]);
validateArtifacts(version);
run("npm", ["run", "release:upload-online:mac", "--", version, "--confirm"]);

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

function run(command, commandArgs) {
  console.log(`[publish-current-mac-update] ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, { env, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
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
