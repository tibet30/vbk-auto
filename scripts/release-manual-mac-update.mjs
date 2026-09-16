import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const args = process.argv.slice(2);
const shouldBuild = args.includes("--build");
const explicitVersion = args.find((arg) => !arg.startsWith("--"));
const packageJsonPath = path.resolve("package.json");
const pkg = await import(`${packageJsonPath}?t=${Date.now()}`, { with: { type: "json" } });
const version = explicitVersion ?? pkg.default.version;
const env = { ...process.env, NODE_OPTIONS: "" };

validateVersion(version);

console.log(`[manual-mac-update] version=${version}`);
if (!shouldBuild) {
  console.log("[manual-mac-update] dry run only; add --build to build macOS update packages");
  printExpectedArtifacts(version);
  process.exit(0);
}

if (process.platform !== "darwin") {
  fail("macOS update packages must be built on macOS.");
}

run("npm", ["run", "check"]);
run("npm", ["run", "package:mac:universal"]);
validateArtifacts(version);

console.log("[manual-mac-update] ready for upload:");
printExpectedArtifacts(version);
console.log("[manual-mac-update] upload dry-run:");
console.log(`  npm run release:upload-online:mac -- ${version}`);
console.log("[manual-mac-update] upload after confirmation:");
console.log(`  npm run release:upload-online:mac -- ${version} --confirm`);
console.log("[manual-mac-update] after upload, verify:");
console.log("  curl -fsSL https://www.atdtour.com/downloads/sanrentongyou/updates/stable/latest-mac.yml");

function validateArtifacts(version) {
  const artifacts = expectedArtifacts(version);
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
  if (!/^path:\s*.+\.zip\s*$/m.test(manifest)) {
    fail("latest-mac.yml must keep zip as the updater path for future signed auto-install support.");
  }
  if (!/sha512:\s*\S+/.test(manifest)) fail("latest-mac.yml is missing sha512 entries");
}

function expectedArtifacts(version) {
  return [
    path.join("release", `三人同游-${version}-universal.dmg`),
    path.join("release", `三人同游-${version}-universal.dmg.blockmap`),
    path.join("release", `三人同游-${version}-universal.zip`),
    path.join("release", `三人同游-${version}-universal.zip.blockmap`),
    path.join("release", "latest-mac.yml"),
  ];
}

function printExpectedArtifacts(version) {
  for (const artifact of expectedArtifacts(version)) console.log(`[manual-mac-update] - ${artifact}`);
}

function run(command, commandArgs) {
  console.log(`[manual-mac-update] ${command} ${commandArgs.join(" ")}`);
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
  console.error(`[manual-mac-update] ${message}`);
  process.exit(1);
}
