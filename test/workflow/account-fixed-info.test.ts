import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";

async function newDatabase(t: test.TestContext) {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-account-fixed-info-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  return new VbkDatabase(dataPath);
}

test("未保存过的账号读取时所有字段都为空", async (t) => {
  const db = await newDatabase(t);
  const info = db.getAccountFixedInfo("新账号");
  assert.equal(info.accountName, "新账号");
  assert.deepEqual(info.values, {});
});

test("写入一个字段后再读取能拿到原值", async (t) => {
  const db = await newDatabase(t);
  const saved = db.setAccountFixedInfo("供应商A", { servicePhone: "400-820-1234" });
  assert.deepEqual(saved.values, { servicePhone: "400-820-1234" });

  const reread = db.getAccountFixedInfo("供应商A");
  assert.equal(reread.values.servicePhone, "400-820-1234");
});

test("合并更新：未指定的字段保留旧值", async (t) => {
  const db = await newDatabase(t);
  db.setAccountFixedInfo("供应商B", { servicePhone: "400-111-1111" });
  // 假设未来有第二个字段「wechat」，这里只更新 servicePhone，验证合并语义。
  const merged = db.setAccountFixedInfo("供应商B", { servicePhone: "400-222-2222" });
  assert.equal(merged.values.servicePhone, "400-222-2222");
});

test("把字段值清空成空字符串会从存储里清除该项", async (t) => {
  const db = await newDatabase(t);
  db.setAccountFixedInfo("供应商C", { servicePhone: "400-333-3333" });
  const cleared = db.setAccountFixedInfo("供应商C", { servicePhone: "" });
  assert.equal(cleared.values.servicePhone, undefined);
  assert.deepEqual(cleared.values, {});

  // 重新读取也应保持为空，避免 settings 表里残留陈旧空对象。
  const reread = db.getAccountFixedInfo("供应商C");
  assert.deepEqual(reread.values, {});
});

test("保存前会自动 trim，空白字符不会落库", async (t) => {
  const db = await newDatabase(t);
  db.setAccountFixedInfo("供应商D", { servicePhone: "   400-444-4444   " });
  const reread = db.getAccountFixedInfo("供应商D");
  assert.equal(reread.values.servicePhone, "400-444-4444");
});

test("损坏的 JSON 不会让读取崩溃，而是当作空记录返回", async (t) => {
  const db = await newDatabase(t);
  // 直接写一个非 JSON 字符串进 settings，模拟历史脏数据。
  db.setSetting("accountFixedInfo:供应商E", "{not valid json");
  const reread = db.getAccountFixedInfo("供应商E");
  assert.equal(reread.accountName, "供应商E");
  assert.deepEqual(reread.values, {});
});

test("不同账号的固定信息互不干扰", async (t) => {
  const db = await newDatabase(t);
  db.setAccountFixedInfo("供应商F", { servicePhone: "400-555-5555" });
  db.setAccountFixedInfo("供应商G", { servicePhone: "400-666-6666" });

  assert.equal(db.getAccountFixedInfo("供应商F").values.servicePhone, "400-555-5555");
  assert.equal(db.getAccountFixedInfo("供应商G").values.servicePhone, "400-666-6666");
});

test("fixedInfoSchema 至少暴露 servicePhone 一项，且字段定义稳定", async (t) => {
  const schema = VbkDatabase.fixedInfoSchema();
  const servicePhone = schema.find((field) => field.key === "servicePhone");
  assert.ok(servicePhone, "缺少 servicePhone 字段定义");
  assert.equal(servicePhone?.label, "400 电话");
  assert.match(servicePhone?.placeholder || "", /400/);
  assert.equal(servicePhone?.kind, "text");
});

test("select 字段可以保存 ContactCardSelection 并能往返读取", async (t) => {
  const db = await newDatabase(t);
  const selection = { contactCardId: 1753732, displayName: "张三", providerId: 1279416 };
  const saved = db.setAccountFixedInfo("供应商H", { butlerName: selection });
  assert.deepEqual(saved.values.butlerName, selection);

  const reread = db.getAccountFixedInfo("供应商H");
  assert.deepEqual(reread.values.butlerName, selection);
});

test("select 字段传入 null 视为清除", async (t) => {
  const db = await newDatabase(t);
  db.setAccountFixedInfo("供应商I", { butlerName: { contactCardId: 1, displayName: "李四", providerId: 2 } });
  const cleared = db.setAccountFixedInfo("供应商I", { butlerName: null });
  assert.equal(cleared.values.butlerName, undefined);
  assert.deepEqual(cleared.values, {});
});

test("select 字段非法值会被拒，防止脏数据落库", async (t) => {
  const db = await newDatabase(t);
  // 缺少 contactCardId，类型守卫应当拒绝
  assert.throws(() => db.setAccountFixedInfo("供应商J", { butlerName: { displayName: "王五", providerId: 3 } } as never), /联系人/);
  // 完全不是对象
  assert.throws(() => db.setAccountFixedInfo("供应商K", { butlerName: "not an object" as never }), /联系人/);
});

test("text 与 select 字段可以一起合并保存，互不影响", async (t) => {
  const db = await newDatabase(t);
  db.setAccountFixedInfo("供应商L", { servicePhone: "400-777-7777" });
  const updated = db.setAccountFixedInfo("供应商L", { butlerName: { contactCardId: 10, displayName: "赵六", providerId: 100 } });
  assert.equal(updated.values.servicePhone, "400-777-7777");
  assert.deepEqual(updated.values.butlerName, { contactCardId: 10, displayName: "赵六", providerId: 100 });
});

test("读到的历史数据里 select 字段缺关键属性会被丢弃", async (t) => {
  const db = await newDatabase(t);
  // 手工写入一个缺 displayName 的脏记录
  db.setSetting("accountFixedInfo:供应商M", JSON.stringify({ butlerName: { contactCardId: 1, providerId: 2 } }));
  const reread = db.getAccountFixedInfo("供应商M");
  assert.equal(reread.values.butlerName, undefined);
});

test("两个字段可以同时存在且互不影响", async (t) => {
  const db = await newDatabase(t);
  db.setAccountFixedInfo("供应商O", {
    servicePhone: "400-888-8888",
    butlerName: { contactCardId: 100, displayName: "客服 A", providerId: 999 },
  });
  const info = db.getAccountFixedInfo("供应商O");
  assert.equal(info.values.servicePhone, "400-888-8888");
  assert.deepEqual(info.values.butlerName, { contactCardId: 100, displayName: "客服 A", providerId: 999 });
});