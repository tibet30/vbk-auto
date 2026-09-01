import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const mode = process.argv[2] ?? "unit";
if (!["unit", "integration", "browser", "e2e", "all"].includes(mode)) {
  console.error(`用法：node scripts/run-tests.mjs ${"unit|integration|browser|e2e|all"}`);
  process.exit(2);
}

const testFiles = await collectTestFiles(path.join(root, "test"));
const e2eFiles = [];
const integrationFiles = [];
const browserFiles = [];
const unitFiles = [];
for (const file of testFiles) {
  if (await isExplicitE2e(file)) e2eFiles.push(file);
  else if (await reachesPlaywrightDependency(file, new Set())) browserFiles.push(file);
  else if (await reachesLocalServer(file, new Set())) integrationFiles.push(file);
  else unitFiles.push(file);
}

const files = mode === "e2e"
  ? e2eFiles
  : mode === "integration"
    ? integrationFiles
    : mode === "browser"
      ? browserFiles
    : mode === "all"
      ? testFiles
      : unitFiles;
console.log(`[test] mode=${mode} files=${files.length} e2e=${e2eFiles.length} browser=${browserFiles.length} integration=${integrationFiles.length} unit=${unitFiles.length}`);
if (files.length === 0) process.exit(0);

const result = spawnSync(process.execPath, [
  "--import", "tsx",
  "--test",
  "--test-timeout=60000",
  "--test-concurrency=1",
  ...files,
], { stdio: "inherit" });
process.exit(result.status ?? 1);

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

async function isExplicitE2e(file) {
  const source = await readFile(file, "utf8");
  return /@test-layer\s+e2e\b/.test(source);
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
