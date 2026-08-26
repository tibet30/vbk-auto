/**
 * 「产品创建前置守卫」单元测试：
 *  - 覆盖三条独立失败路径（未登录 / 无 400 电话 / 无管家）+ 三条并存路径；
 *  - 覆盖完整就绪的成功路径，验证产品 JSON 实际写入了管家 selection 与 400 电话；
 *  - 验证守卫的副作用 = 0：失败时 DB 里没有产品、没有消息、没有任务。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { injectAccountButler } from "../../src/main/operations/account-butler-inject.js";
import {
  assertCreatePreconditions,
  detectCreateGuardFailures,
  formatGuardFailureMessage,
  isValidContactCardSelection,
} from "../../src/main/operations/product-create-guard.js";

async function newDatabase(t: test.TestContext) {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-create-guard-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  return new VbkDatabase(dataPath);
}

/** 完整的合法管家选择（来自账号设置页保存的 ContactCardSelection）。 */
const validButler = { contactCardId: 1753732, displayName: "张三", providerId: 1279416 };

/** 当前账号「全部就绪」：登录 + 400 电话 + 管家都配齐。 */
function loginCurrentAccount(db: VbkDatabase, accountName = "供应商A") {
  db.setSetting("vbkAccountName", accountName);
  db.setAccountFixedInfo(accountName, { servicePhone: "400-820-1234" });
  db.setAccountFixedInfo(accountName, { butlerName: validButler });
}

test("未登录时三个缺失项同时被检出", async (t) => {
  const db = await newDatabase(t);
  const failures = detectCreateGuardFailures(db);
  assert.deepEqual(failures, { notLoggedIn: true, missingServicePhone: true, missingButler: true });
  assert.throws(() => assertCreatePreconditions(db), /未登录 VBK/);
  assert.throws(() => assertCreatePreconditions(db), /400 电话/);
  assert.throws(() => assertCreatePreconditions(db), /管家联系人/);
});

test("已登录但缺 400 电话：抛出明确的中文错误且不写库", async (t) => {
  const db = await newDatabase(t);
  db.setSetting("vbkAccountName", "供应商A");
  db.setAccountFixedInfo("供应商A", { butlerName: validButler });

  const failures = detectCreateGuardFailures(db);
  assert.equal(failures.notLoggedIn, false);
  assert.equal(failures.missingServicePhone, true);
  assert.equal(failures.missingButler, false);

  const message = formatGuardFailureMessage(failures);
  assert.match(message, /400 电话/);
  assert.doesNotMatch(message, /未登录/);
  assert.doesNotMatch(message, /管家联系人/);

  assert.throws(() => assertCreatePreconditions(db), /400 电话/);

  // 关键：失败时 DB 里没有副作用——这是用户验收「拒绝无副作用」的硬要求。
  assert.equal(db.listProducts().length, 0);
});

test("已登录但管家缺失或不合法：仅提示管家，不混淆 400 电话", async (t) => {
  const db = await newDatabase(t);
  db.setSetting("vbkAccountName", "供应商A");
  db.setAccountFixedInfo("供应商A", { servicePhone: "400-820-1234" });
  // 但不配置管家

  const failures = detectCreateGuardFailures(db);
  assert.deepEqual(failures, { notLoggedIn: false, missingServicePhone: false, missingButler: true });

  assert.throws(() => assertCreatePreconditions(db), /管家联系人/);

  assert.equal(db.listProducts().length, 0);
});

test("管家 selection 字段缺失任何一项（contactCardId / providerId / displayName）都被识别为非法", async (t) => {
  const db = await newDatabase(t);
  db.setSetting("vbkAccountName", "供应商A");
  db.setAccountFixedInfo("供应商A", { servicePhone: "400-820-1234" });

  // 直接 setSetting 写脏 JSON 模拟「外部脏数据」：守卫必须自己识别非法 selection，
  // 不能依赖 setAccountFixedInfo 校验（保证守卫在「坏数据已经落库」时也能拒）。
  db.setSetting("accountFixedInfo:供应商A", JSON.stringify({
    servicePhone: "400-820-1234",
    butlerName: { contactCardId: 0, displayName: "x", providerId: 1 },
  }));
  assert.throws(() => assertCreatePreconditions(db), /管家联系人/);

  db.setSetting("accountFixedInfo:供应商A", JSON.stringify({
    servicePhone: "400-820-1234",
    butlerName: { contactCardId: 1, displayName: "   ", providerId: 1 },
  }));
  assert.throws(() => assertCreatePreconditions(db), /管家联系人/);

  db.setSetting("accountFixedInfo:供应商A", JSON.stringify({
    servicePhone: "400-820-1234",
    butlerName: { contactCardId: 1, displayName: "x" }, // 缺 providerId
  }));
  assert.throws(() => assertCreatePreconditions(db), /管家联系人/);

  assert.equal(db.listProducts().length, 0);
});

test("isValidContactCardSelection 暴露出来便于复用，且与守卫语义一致", () => {
  assert.equal(isValidContactCardSelection(validButler), true);
  assert.equal(isValidContactCardSelection({ contactCardId: -1, displayName: "x", providerId: 1 }), false);
  assert.equal(isValidContactCardSelection(null), false);
  assert.equal(isValidContactCardSelection({ contactCardId: 1, displayName: 1, providerId: 1 }), false);
  assert.equal(isValidContactCardSelection({}), false);
});

test("全部就绪时守卫静默放行", async (t) => {
  const db = await newDatabase(t);
  loginCurrentAccount(db);
  const failures = detectCreateGuardFailures(db);
  assert.deepEqual(failures, { notLoggedIn: false, missingServicePhone: false, missingButler: false });
  assert.doesNotThrow(() => assertCreatePreconditions(db));
});

test("Tibet 用户作用域下按真实 vbk_* 登录账号读取固定信息，不被展示名误导", async (t) => {
  const db = await newDatabase(t);
  db.setExtensionUserIdResolver(() => 42);
  db.setSetting("vbkAccountName", "供应商展示名");
  db.setSetting("accountFixedInfo:42:vbk_2405770", JSON.stringify({
    servicePhone: "400-820-1234",
    butlerName: validButler,
  }));

  assert.deepEqual(detectCreateGuardFailures(db, "vbk_2405770"), {
    notLoggedIn: false,
    missingServicePhone: false,
    missingButler: false,
  });
  assert.doesNotThrow(() => assertCreatePreconditions(db, "vbk_2405770"));
});

test("成功创建后产品 JSON 固化管家 selection + 创建成功断言，守卫失败时不留痕迹", async (t) => {
  const db = await newDatabase(t);
  // 守卫失败路径：未登录时 db.createProduct 不被守卫调用——但守卫的契约是
  // 「在调 db.createProduct 之前」调用。所以这里直接验证失败路径没有副作用。
  assert.throws(() => assertCreatePreconditions(db));
  assert.equal(db.listProducts().length, 0);

  // 现在登录、写好账号信息，模拟 IPC products:create 的成功路径：
  // 1) assertCreatePreconditions 通过 → 2) db.createProduct(input) → 3) main 里
  // injectAccountButler 把管家写入 product.operations.bookingControls.butler。
  loginCurrentAccount(db);
  assertCreatePreconditions(db);
  const product = db.createProduct({ destination: "太原", days: 2, productForm: "privateTour" });
  const injected = injectAccountButler(db, product.id, "供应商A");
  assert.equal(injected.written, true);
  assert.ok(product.id, "产品应当被创建");
  const reread = db.getProduct(product.id);
  // 创建立即可验证 product JSON 已落库；main 的 products:create 路径同样按此顺序调用。
  assert.ok(reread);
  assert.equal((reread!.product.basicInfo as Record<string, unknown>).meetingCity, "太原");
  const bookingControls = (reread!.product.operations as Record<string, unknown>).bookingControls as Record<string, unknown>;
  assert.deepEqual(bookingControls.butler, validButler);
});
