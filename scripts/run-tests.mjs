import os from "node:os";
import { REQUIRED_PRODUCT_SUITES, assertProductSuites, assertProductReceipt } from "./product-regression-contract.mjs";
import { readFile } from "node:fs/promises";
import { existsSync, statSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { selectChangedTestFiles } from "./test-selection.mjs";

const root = process.cwd();
const mode = process.argv[2] ?? "unit";
const changedOnly = process.argv.slice(3).includes("--changed");
if (!["unit", "integration", "browser", "e2e", "e2e-live", "all"].includes(mode)
  || process.argv.slice(3).some((argument) => argument !== "--changed")) {
  console.error(`用法：node scripts/run-tests.mjs ${"unit|integration|browser|e2e|e2e-live|all"} [--changed]`);
  process.exit(2);
}

const testFiles = await collectTestFiles(path.join(root, "test"));
const e2eFiles = [];
const liveE2eFiles = [];
const integrationFiles = [];
const browserFiles = [];
const unitFiles = [];
for (const file of testFiles) {
  const layer = await explicitTestLayer(file);
  if (layer === "e2e-live") liveE2eFiles.push(file);
  else if (layer === "e2e") e2eFiles.push(file);
  else if (await reachesPlaywrightDependency(file, new Set())) browserFiles.push(file);
  else if (await reachesLocalServer(file, new Set())) integrationFiles.push(file);
  else unitFiles.push(file);
}
const modeFiles = mode === "e2e-live"
  ? liveE2eFiles
  : mode === "e2e"
  ? e2eFiles
  : mode === "integration"
    ? integrationFiles
    : mode === "browser"
      ? browserFiles
    : mode === "all"
      ? testFiles.filter(file => !liveE2eFiles.includes(file))
      : unitFiles;
const selection = changedOnly
  ? await selectChangedTestFiles({ root, testFiles: modeFiles, changedFiles: changedFilesSinceHead() })
  : { files: modeFiles, reason: "all-tests" };
// Every changed local run, including the default `npm test`, must carry the
// fixed corpus. The live mode is deliberately excluded because it is the
// separately authorised external-entry path.
const enforceProductRegression = mode !== "e2e-live" && (changedOnly || mode === "all" || mode === "e2e");
const files = [...new Set([...selection.files, ...(enforceProductRegression
  ? REQUIRED_PRODUCT_SUITES.map(file => path.resolve(root, file)) : [])])];
if (enforceProductRegression) {
  assertProductSuites(root, files);
  for (const suite of REQUIRED_PRODUCT_SUITES) {
    if (!testFiles.includes(path.resolve(root, suite)) || liveE2eFiles.includes(path.resolve(root, suite))) {
      throw new Error(`强制产品回归文件缺失或被标为真实录入：${suite}`);
    }
  }
}
console.log(`[test] mode=${mode} scope=${changedOnly ? "changed" : "all"} reason=${selection.reason} files=${files.length} e2e=${e2eFiles.length} browser=${browserFiles.length} integration=${integrationFiles.length} unit=${unitFiles.length}`);
if (files.length === 0) process.exit(0);

const receiptDirectory = enforceProductRegression ? mkdtempSync(path.join(os.tmpdir(), 'vbk-regression-receipt-')) : undefined;
const receiptFile = receiptDirectory && path.join(receiptDirectory, 'results.json');
let exitCode = 1;
try {
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "--test",
    mode === "e2e-live" ? "--test-timeout=360000" : "--test-timeout=60000",
    "--test-concurrency=1",
    ...(receiptFile ? ["--test-reporter=tap", "--test-reporter=./scripts/product-regression-reporter.mjs",
      "--test-reporter-destination=stdout", `--test-reporter-destination=${receiptFile}`] : []),
    ...files,
  ], { stdio: "inherit" });
  exitCode = result.status ?? 1;
  if (receiptFile) {
    assertProductReceipt(root, JSON.parse(readFileSync(receiptFile, 'utf8')));
    console.log('[test] 强制产品回归执行核验：5 项正向 + 20 项负向全部通过，无漏跑或跳过。');
  }
} catch (error) {
  console.error(`[test] 强制产品回归执行核验失败：${error instanceof Error ? error.message : error}`);
  exitCode = 1;
} finally {
  if (receiptDirectory) rmSync(receiptDirectory, { recursive: true, force: true });
}
process.exit(exitCode);

async function collectTestFiles(directory) {
  const entries = await readDir(directory);
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectTestFiles(absolute));
    else if (entry.name.endsWith(".test.ts")) files.push(absolute);
  }
  return files.sort();
}

async function readDir(directory) {
  const { readdir } = await import("node:fs/promises");
  return readdir(directory, { withFileTypes: true });
}

async function explicitTestLayer(file) {
  const source = await readFile(file, "utf8");
  return source.match(/^\s*\/\/\s*@test-layer\s+(e2e-live|e2e)\b/m)?.[1];
}

async function reachesPlaywrightDependency(file, visited) {
  if (visited.has(file)) return false;
  visited.add(file);
  const source = await readFile(file, "utf8");
  if (/from\s+["']playwright["']|import\s+["']playwright["']|chromium\.launch\s*\(/.test(source)) return true;
  const imports = [...source.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((specifier) => specifier.startsWith("."));
  for (const specifier of imports) {
    const dependency = resolveLocalImport(path.dirname(file), specifier);
    if (dependency && await reachesPlaywrightDependency(dependency, visited)) return true;
  }
  return false;
}

async function reachesLocalServer(file, visited) {
  if (visited.has(file)) return false;
  visited.add(file);
  const source = await readFile(file, "utf8");
  if (/createServer\s*\(|\.listen\s*\(/.test(source)) return true;
  const imports = [...source.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((specifier) => specifier.startsWith("."));
  for (const specifier of imports) {
    const dependency = resolveLocalImport(path.dirname(file), specifier);
    if (dependency && await reachesLocalServer(dependency, visited)) return true;
  }
  return false;
}

function resolveLocalImport(directory, specifier) {
  const base = path.resolve(directory, specifier);
  const withoutJsExtension = base.endsWith(".js") ? base.slice(0, -3) : base;
  for (const candidate of [
    base,
    withoutJsExtension,
    `${withoutJsExtension}.ts`,
    `${withoutJsExtension}.tsx`,
    `${withoutJsExtension}.cts`,
    path.join(withoutJsExtension, "index.ts"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

function changedFilesSinceHead() {
  const tracked = runGit(["diff", "--name-only", "HEAD"]);
  const untracked = runGit(["ls-files", "--others", "--exclude-standard"]);
  if (tracked === undefined || untracked === undefined) {
    console.warn("[test] 无法读取 Git 改动，改为运行当前模式的全部测试。");
    return testFiles;
  }
  return [...new Set([...tracked, ...untracked])];
}

function runGit(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.split("\n").filter(Boolean);
}
