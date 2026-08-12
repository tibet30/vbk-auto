import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("封面点击已打开图库弹窗时不再重复点击被遮挡的入口", async () => {
  const source = await readFile(
    new URL("../src/main/automation/ctrip/presentation/main.ts", import.meta.url),
    "utf8",
  );
  const addClick = source.indexOf('await addCard.click({ force: true })');
  const dialogCheck = source.indexOf('if (!(await dialog.isVisible().catch(() => false)))', addClick);
  const libraryClick = source.indexOf("await libraryImport.click()", dialogCheck);

  assert.ok(addClick >= 0);
  assert.ok(dialogCheck > addClick);
  assert.ok(libraryClick > dialogCheck);
});
