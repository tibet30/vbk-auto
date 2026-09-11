import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes("--dry-run");
const explicitVersion = rawArgs.find((arg) => !arg.startsWith("--"));
const packageJsonPath = path.resolve("package.json");
const pkg = await import(`${packageJsonPath}?t=${Date.now()}`, { with: { type: "json" } });
const currentVersion = pkg.default.version;
const nextVersion = explicitVersion ?? bumpPatch(currentVersion);
const tagName = `v${nextVersion}`;
const env = { ...process.env, NODE_OPTIONS: "" };

validateVersion(nextVersion);
ensureTagDoesNotExist(tagName);

console.log(`[release] current=${currentVersion} next=${nextVersion}`);
if (dryRun) {
  console.log(`[release] dry run only; would create ${tagName}`);
  console.log("[release] required artifacts:");
  for (const artifact of releaseArtifacts(nextVersion)) console.log(`[release] - ${artifact.file}`);
  process.exit(0);
}
run("npm", ["version", nextVersion, "--no-git-tag-version"]);
run("npm", ["run", "check"]);
run("npm", ["run", "test:changed"]);
run("git", ["diff", "--check"]);

for (const artifact of releaseArtifacts(nextVersion)) buildOrVerifyArtifact(artifact);

run("git", ["add", "-A"]);
ensureStagedChanges();
run("git", ["commit", "-m", `chore: release v${nextVersion}`]);
run("git", ["tag", "-a", tagName, "-m", `Release v${nextVersion}`]);

console.log(`[release] created commit and tag ${tagName}`);
for (const artifact of releaseArtifacts(nextVersion)) console.log(`[release] package: ${artifact.file}`);
console.log("[release] push was not run");

function run(command, args) {
  console.log(`[release] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { env, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function ensureStagedChanges() {
  const result = spawnSync("git", ["diff", "--cached", "--quiet"], { env, stdio: "ignore" });
  if (result.status === 0) fail("No staged changes to commit.");
  if (result.status !== 1) process.exit(result.status ?? 1);
}

function ensureTagDoesNotExist(tagName) {
  const result = spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tagName}`], { env, stdio: "ignore" });
  if (result.status === 0) fail(`Tag already exists: ${tagName}`);
}

function releaseArtifacts(version) {
  return [
    {
      name: "macOS universal DMG",
      file: path.join("release", `三人同游-${version}-universal.dmg`),
      extraFiles: [path.join("release", `三人同游-${version}-universal.dmg.blockmap`)],
      canBuild: process.platform === "darwin",
      command: ["npm", ["run", "package:mac:universal"]],
      missingMessage: "macOS universal packages must be built on macOS.",
    },
    {
      name: "Windows x64 installer",
      file: path.join("release", `三人同游-${version}-x64-setup.exe`),
      extraFiles: [path.join("release", `三人同游-${version}-x64-setup.exe.blockmap`)],
      canBuild: process.platform === "win32" || process.env.VBK_ALLOW_CROSS_PACKAGE === "1",
      command: ["npm", ["run", "package:win"]],
      missingMessage: "Windows installers must be built on Windows, or run with VBK_ALLOW_CROSS_PACKAGE=1 for an unsupported cross-build attempt.",
    },
  ];
}

function buildOrVerifyArtifact(artifact) {
  if (artifact.canBuild) {
    console.log(`[release] building ${artifact.name}`);
    run(...artifact.command);
  } else if (!artifactExists(artifact)) {
    fail(`${artifact.missingMessage} Missing required artifact: ${artifact.file}`);
  } else {
    console.log(`[release] using existing ${artifact.name}: ${artifact.file}`);
  }
  if (!artifactExists(artifact)) fail(`Expected package output was not found: ${artifact.file}`);
}

function artifactExists(artifact) {
  return existsSync(artifact.file) && artifact.extraFiles.every((file) => existsSync(file));
}

function bumpPatch(version) {
  validateVersion(version);
  const [major, minor, patch] = version.split(".").map((part) => Number(part));
  return `${major}.${minor}.${patch + 1}`;
}

function validateVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`Version must use x.y.z format, got: ${version}`);
  }
}

function fail(message) {
  console.error(`[release] ${message}`);
  process.exit(1);
}
