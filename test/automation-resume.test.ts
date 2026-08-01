import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../src/main/database.js";

async function freshDb(prefix: string, t: { after: (fn: () => unknown) => void }) {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  return new VbkDatabase(dataPath);
}

test("新项目的基本信息尚未保存", async (t) => {
  const db = await freshDb("vbk-basic-", t);
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });

  assert.equal(project.basicInfoSaved, false);
});

test("仅记录产品 ID 不代表基本信息已保存", async (t) => {
  const db = await freshDb("vbk-basic-partial-", t);
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });

  // 携程草稿已创建但基本信息填写失败时，重试必须能补跑 basic 阶段，
  // 否则那次失败的填写永远不会被修复。
  db.setProductId(project.id, "123456");
  const afterCreate = db.getProject(project.id)!;

  assert.equal(afterCreate.productId, "123456");
  assert.equal(afterCreate.basicInfoSaved, false);
});

test("基本信息保存成功后会置位", async (t) => {
  const db = await freshDb("vbk-basic-done-", t);
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });

  db.setProductId(project.id, "123456");
  db.setBasicInfoSaved(project.id);

  assert.equal(db.getProject(project.id)!.basicInfoSaved, true);
});
