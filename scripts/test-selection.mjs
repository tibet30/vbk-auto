import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const GLOBAL_TEST_RUNTIME_FILES = new Set([
  "package.json",
  "package-lock.json",
  "scripts/run-tests.mjs",
  "scripts/test-selection.mjs",
]);

/**
 * Select only test files whose local import graph reaches a changed file.
 * A changed test is always selected; a test-runner/config change selects all
 * tests because it can alter execution for every suite.
 */
export async function selectChangedTestFiles({ root, testFiles, changedFiles }) {
  const changed = new Set(changedFiles.map((file) => toAbsolutePath(root, file)));
  if (changed.size === 0) return { files: [], reason: "no-changes" };

  if (changedFiles.some((file) => isGlobalTestRuntimeFile(root, file))) {
    return { files: [...testFiles], reason: "test-runtime-changed" };
  }

  const files = [];
  for (const file of testFiles) {
    if (changed.has(file) || await reachesChangedDependency(file, changed, new Set())) {
      files.push(file);
    }
  }
  return { files, reason: files.length > 0 ? "affected-tests" : "no-affected-tests" };
}

async function reachesChangedDependency(file, changed, visited) {
  if (changed.has(file)) return true;
  if (visited.has(file) || !existsSync(file)) return false;
  visited.add(file);
  const source = await readFile(file, "utf8");
  for (const specifier of localImportSpecifiers(source)) {
    const dependency = resolveLocalImport(path.dirname(file), specifier);
    if (dependency && await reachesChangedDependency(dependency, changed, visited)) return true;
  }
  return false;
}

function localImportSpecifiers(source) {
  return [...source.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((specifier) => specifier.startsWith("."));
}

function resolveLocalImport(directory, specifier) {
  const base = path.resolve(directory, specifier);
  const withoutJavaScriptExtension = base.replace(/\.(?:[cm]?js)$/, "");
  const candidates = [
    base,
    withoutJavaScriptExtension,
    ...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"]
      .map((extension) => `${withoutJavaScriptExtension}${extension}`),
    ...["index.ts", "index.tsx", "index.mts", "index.cts", "index.js", "index.mjs", "index.cjs"]
      .map((filename) => path.join(withoutJavaScriptExtension, filename)),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function isGlobalTestRuntimeFile(root, file) {
  const relative = path.relative(root, toAbsolutePath(root, file));
  return GLOBAL_TEST_RUNTIME_FILES.has(relative)
    || /^tsconfig(?:\.[^/]+)?\.json$/.test(relative)
    || /^vite\.config\.[^/]+$/.test(relative);
}

function toAbsolutePath(root, file) {
  return path.resolve(root, file);
}
