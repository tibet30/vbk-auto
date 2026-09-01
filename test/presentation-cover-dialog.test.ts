import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("封面使用已有 imageId 直接绑定，不再重新打开图库弹窗", async () => {
  const source = await readFile(
    new URL("../src/main/automation/ctrip/presentation/main.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /bindCtripLibraryCoverViaApi\(page, cover\.imageId, productId\)/);
  const coverStart = source.indexOf("export async function selectCtripLibraryCover");
  const coverEnd = source.indexOf("export async function fillAndSavePresentation", coverStart);
  const coverSource = source.slice(coverStart, coverEnd);
  assert.doesNotMatch(coverSource, /searchImage|importpic-modal|同意并导入|cover\.poi/);
});

test("普通景点图库动态列表使用原子搜索和单次候选快照", async () => {
  const source = await readFile(
    new URL("../src/main/automation/ctrip/presentation/main.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /await input\.fill\(value\)/);
  assert.doesNotMatch(source, /input\.pressSequentially/);
  assert.equal((source.match(/cards\.allInnerTexts\(\)/g) ?? []).length, 1);
  assert.doesNotMatch(source, /cards\.nth\(index\)\.innerText/);
});

test("普通景点配图仍保留图库弹窗流程", async () => {
  const source = await readFile(
    new URL("../src/main/automation/ctrip/presentation/main.ts", import.meta.url),
    "utf8",
  );

  const imageStart = source.indexOf("export async function selectCtripLibraryImage");
  const imageEnd = source.indexOf("async function fillFirstVisible", imageStart);
  const imageSource = source.slice(imageStart, imageEnd);
  assert.match(imageSource, /从图库资源导入/);
  assert.match(imageSource, /同意并导入/);
});
