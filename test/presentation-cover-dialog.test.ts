import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (rel: string) =>
  readFile(new URL(`../${rel}`, import.meta.url), "utf8");

// After split, presentation/main.ts is a barrel. The contract lives in
// presentation/save.ts and presentation/image-checkpoint.ts.
const presentationSrc = [
  await read("src/main/automation/ctrip/presentation/main.ts"),
  await read("src/main/automation/ctrip/presentation/presentation.ts"),
  await read("src/main/automation/ctrip/presentation/presentation/save.ts"),
  await read("src/main/automation/ctrip/presentation/presentation/select.ts"),
  await read("src/main/automation/ctrip/presentation/presentation/cover-attempts.ts"),
  await read("src/main/automation/ctrip/presentation/image-checkpoint.ts"),
].join("\n");

test("封面使用已有 imageId 直接绑定，不再重新打开图库弹窗", () => {
  assert.match(presentationSrc, /bindCtripLibraryCoverViaApi\(page, candidate\.imageId, productId(?:, options)?\)/);
  const coverStart = presentationSrc.indexOf("export async function selectCtripLibraryCover");
  const coverEnd = presentationSrc.indexOf("export async function fillAndSavePresentation", coverStart);
  const coverSource = presentationSrc.slice(coverStart, coverEnd);
  assert.doesNotMatch(coverSource, /searchImage|importpic-modal|同意并导入|cover\.poi/);
});

test("普通景点图库动态列表使用原子搜索和单次候选快照", () => {
  assert.match(presentationSrc, /await input\.fill\(value\)/);
  assert.doesNotMatch(presentationSrc, /input\.pressSequentially/);
  assert.equal((presentationSrc.match(/cards\.allInnerTexts\(\)/g) ?? []).length, 1);
  assert.doesNotMatch(presentationSrc, /cards\.nth\(index\)\.innerText/);
});

test("普通景点配图仍保留图库弹窗流程", () => {
  const imageStart = presentationSrc.indexOf("export async function selectCtripLibraryImage");
  const imageEnd = presentationSrc.indexOf("async function fillFirstVisible", imageStart);
  const imageSource = presentationSrc.slice(imageStart, imageEnd);
  assert.match(imageSource, /从图库资源导入/);
  assert.match(imageSource, /同意并导入/);
});