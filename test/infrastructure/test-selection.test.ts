import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { selectChangedTestFiles } from "../../scripts/test-selection.mjs";

test("selectChangedTestFiles selects only tests that import the changed source", async (context) => {
  const fixture = await createFixture(context, {
    "src/feature.ts": "export const feature = true;\n",
    "src/other.ts": "export const other = true;\n",
    "test/feature.test.ts": 'import "../src/feature.js";\n',
    "test/other.test.ts": 'import "../src/other.js";\n',
  });

  const result = await selectChangedTestFiles({
    root: fixture.root,
    testFiles: fixture.testFiles,
    changedFiles: ["src/feature.ts"],
  });

  assert.deepEqual(relativeFiles(fixture.root, result.files), ["test/feature.test.ts"]);
  assert.equal(result.reason, "affected-tests");
});

test("selectChangedTestFiles follows local re-export chains and includes changed tests", async (context) => {
  const fixture = await createFixture(context, {
    "src/feature.ts": "export const feature = true;\n",
    "src/index.ts": 'export * from "./feature.js";\n',
    "test/feature.test.ts": 'import "../src/index.js";\n',
    "test/new.test.ts": "test('new', () => {});\n",
  });

  const result = await selectChangedTestFiles({
    root: fixture.root,
    testFiles: fixture.testFiles,
    changedFiles: ["src/feature.ts", "test/new.test.ts"],
  });

  assert.deepEqual(relativeFiles(fixture.root, result.files), ["test/feature.test.ts", "test/new.test.ts"]);
});

test("selectChangedTestFiles runs the selected mode in full when test runtime changes", async (context) => {
  const fixture = await createFixture(context, {
    "test/one.test.ts": "test('one', () => {});\n",
    "test/two.test.ts": "test('two', () => {});\n",
  });

  const result = await selectChangedTestFiles({
    root: fixture.root,
    testFiles: fixture.testFiles,
    changedFiles: ["package.json"],
  });

  assert.deepEqual(relativeFiles(fixture.root, result.files), ["test/one.test.ts", "test/two.test.ts"]);
  assert.equal(result.reason, "test-runtime-changed");
});

test("selectChangedTestFiles skips tests for changes outside their local dependency graphs", async (context) => {
  const fixture = await createFixture(context, {
    "src/feature.ts": "export const feature = true;\n",
    "test/feature.test.ts": 'import "../src/feature.js";\n',
  });

  const result = await selectChangedTestFiles({
    root: fixture.root,
    testFiles: fixture.testFiles,
    changedFiles: ["README.md"],
  });

  assert.deepEqual(result.files, []);
  assert.equal(result.reason, "no-affected-tests");
});

test("selectChangedTestFiles skips execution when Git reports no changes", async (context) => {
  const fixture = await createFixture(context, {
    "test/feature.test.ts": "test('feature', () => {});\n",
  });

  const result = await selectChangedTestFiles({
    root: fixture.root,
    testFiles: fixture.testFiles,
    changedFiles: [],
  });

  assert.deepEqual(result.files, []);
  assert.equal(result.reason, "no-changes");
});

async function createFixture(context: test.TestContext, files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vbk-test-selection-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await Promise.all(Object.entries(files).map(async ([relative, content]) => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }));
  return {
    root,
    testFiles: Object.keys(files)
      .filter((file) => file.endsWith(".test.ts"))
      .map((file) => path.join(root, file))
      .sort(),
  };
}

function relativeFiles(root: string, files: string[]) {
  return files.map((file) => path.relative(root, file));
}
