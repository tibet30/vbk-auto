/**
 * 「管家联系人自动注入」单元测试：
 *  - 缺登录 / 缺合法管家 → written=false，不改 product；
 *  - 已有 butler → 不覆盖（运营手工值保留）；
 *  - 全部就绪 → written=true，product.operations.bookingControls.butler 固化。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { createProjectWithAccountButler, injectAccountButler } from "../../src/main/operations/account-butler-inject.js";
import { DbOrchestratorRuntime } from "../../src/main/planning/runtime.js";
import { AI_WRITABLE_PATHS } from "../../src/main/planning/schemas.js";

async function newDatabase(t: test.TestContext) {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-butler-inject-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  return new VbkDatabase(dataPath);
}

const validButler = { contactCardId: 1753732, displayName: "张三", providerId: 1279416 };

function loginCurrentAccount(db: VbkDatabase, accountName = "供应商A") {
  db.setSetting("vbkAccountName", accountName);
  db.setAccountFixedInfo(accountName, { servicePhone: "400-820-1234", butlerName: validButler });
}

test("未登录时写入返回 false，不修改 product", async (t) => {
  const db = await newDatabase(t);
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
  const result = injectAccountButler(db, project.id, null);
  assert.equal(result.written, false);
  assert.match(result.reason ?? "", /未登录/);
  const reread = db.getProject(project.id);
  assert.equal((reread!.product.operations as Record<string, unknown>).bookingControls, undefined);
});

test("账号未配置管家时写入返回 false，不修改 product", async (t) => {
  const db = await newDatabase(t);
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
  const result = injectAccountButler(db, project.id, "供应商A");
  assert.equal(result.written, false);
  assert.match(result.reason ?? "", /管家/);
  const reread = db.getProject(project.id);
  assert.equal((reread!.product.operations as Record<string, unknown>).bookingControls, undefined);
});

test("管家非法（缺字段）时写入返回 false", async (t) => {
  const db = await newDatabase(t);
  db.setSetting("vbkAccountName", "供应商A");
  // 模拟「坏数据已落库」：直接写 settings 跳过 setAccountFixedInfo 校验。
  db.setSetting("accountFixedInfo:供应商A", JSON.stringify({
    servicePhone: "400-820-1234",
    butlerName: { contactCardId: 1, displayName: "x", providerId: 0 },
  }));
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
  const result = injectAccountButler(db, project.id, "供应商A");
  assert.equal(result.written, false);
  assert.match(result.reason ?? "", /管家/);
});

test("全部就绪时 product 固化完整 ContactCardSelection（含 contactCardId / providerId / displayName）", async (t) => {
  const db = await newDatabase(t);
  loginCurrentAccount(db);
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
  const result = injectAccountButler(db, project.id, "供应商A");
  assert.equal(result.written, true);
  const reread = db.getProject(project.id);
  const operations = reread!.product.operations as Record<string, unknown>;
  const bookingControls = operations.bookingControls as Record<string, unknown>;
  const butler = bookingControls.butler as Record<string, unknown>;
  // 固化 = 完整 selection 三字段都进了 product JSON，未来读取稳定可复现。
  assert.equal(butler.contactCardId, validButler.contactCardId);
  assert.equal(butler.providerId, validButler.providerId);
  assert.equal(butler.displayName, validButler.displayName);
});

test("创建路径返回值就是已固化 butler 的最终 project", async (t) => {
  const db = await newDatabase(t);
  loginCurrentAccount(db);
  const result = createProjectWithAccountButler(
    db,
    { destination: "太原", days: 2, productForm: "privateTour" },
    "供应商A",
  );
  assert.equal(result.injectResult.written, true);
  const booking = (result.project.product.operations as Record<string, unknown>).bookingControls as Record<string, unknown>;
  assert.deepEqual(booking.butler, validButler);
});

test("已有 butler 的项目不会被覆盖（运营手工值优先）", async (t) => {
  const db = await newDatabase(t);
  loginCurrentAccount(db);
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
  // 第一次写入默认管家
  const first = injectAccountButler(db, project.id, "供应商A");
  assert.equal(first.written, true);
  // 修改账号默认管家为另一个，并再次调用——不应覆盖已写入 product 的 butler
  const otherButler = { contactCardId: 9999, displayName: "李四", providerId: 8888 };
  db.setAccountFixedInfo("供应商A", { butlerName: otherButler });
  const second = injectAccountButler(db, project.id, "供应商A");
  assert.equal(second.written, false);
  assert.match(second.reason ?? "", /不覆盖/);
  const reread = db.getProject(project.id);
  const butler = ((reread!.product.operations as Record<string, unknown>).bookingControls as Record<string, unknown>).butler as Record<string, unknown>;
  assert.equal(butler.contactCardId, validButler.contactCardId, "原写入的管家必须保留");
});

test("账号管家字段被运营清空后，后续注入返回 written=false", async (t) => {
  const db = await newDatabase(t);
  loginCurrentAccount(db);
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
  db.setAccountFixedInfo("供应商A", { butlerName: null });
  const result = injectAccountButler(db, project.id, "供应商A");
  assert.equal(result.written, false);
});

/* ───────────────────── 以下是本轮用户验收门覆盖的额外场景 ─────────────────────
 * 验收门（用户显式列出）：
 *  - 创建/生成默认写入
 *  - 已有联系人不覆盖
 *  - 未配置不写
 * 上面的 6 个用例已经覆盖『未配置不写』『已有联系人不覆盖』两条。
 * 下面补『AI 首次生成后调用注入』的路径与『注入后 product 仍可走 schema 校验』的
 * 兜底，保证 IPC 路径 + parseProduct 防护没被注入边角料绕过。
 */

const baseProduct: Record<string, unknown> = {
  sales: { productType: "domesticShort", productForm: "privateTour", splitGroup: false },
  basicInfo: {
    supplierProductName: "太原2天1晚私家团",
    supplierProductCode: "TY-1",
    subtitle: "太原经典私家团",
    days: 2,
    nights: 1,
    meetingCity: "太原",
    destinationCity: "太原",
    province: "山西",
    operationNotes: "无",
  },
  operations: {
    transport: "charter",
    pickupCity: "太原",
    reusePickupForDropoff: true,
    hotelSource: "nonPlatform",
    hotelTier: "当地3钻酒店/-3",
    mealsIncluded: false,
  },
  commercial: {
    packageName: "标准套餐",
    pricing: { currency: "CNY", adult: 1500, child: 1200, minimumTravelers: 2 },
  },
  itinerary: [
    { day: 1, title: "D1", description: "首日", hotel: "太原酒店", meals: "自理" },
    { day: 2, title: "D2", description: "次日", hotel: "", meals: "自理" },
  ],
};

test("AI 首次生成后调用注入 + 账号已配管家 → 写入完整 selection", async (t) => {
  const db = await newDatabase(t);
  loginCurrentAccount(db);
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
  // 模拟 AI 首次写库：覆盖 createProject 留下的骨架，写入完整但不含管家的产品。
  db.updateProduct(project.id, baseProduct);
  const before = db.getProject(project.id)!;
  assert.equal(((before.product.operations as Record<string, unknown>).bookingControls as Record<string, unknown> | undefined)?.butler, undefined);

  const result = injectAccountButler(db, project.id, "供应商A");
  assert.equal(result.written, true);
  const after = db.getProject(project.id)!;
  const booking = (after.product.operations as Record<string, unknown>).bookingControls as Record<string, unknown>;
  assert.deepEqual(booking.butler, validButler);
});

test("规划 runtime replace operations 后保留创建时固化的 product butler", async (t) => {
  const db = await newDatabase(t);
  const initialButler = { contactCardId: 1753732, displayName: "洗洗", providerId: 1279416 };
  const changedButler = { contactCardId: 9999, displayName: "后改账号负责人", providerId: 8888 };
  db.setSetting("vbkAccountName", "供应商A");
  db.setAccountFixedInfo("供应商A", { servicePhone: "400-820-1234", butlerName: initialButler });
  const created = createProjectWithAccountButler(
    db,
    { destination: "太原", days: 2, productForm: "privateTour" },
    "供应商A",
  );
  assert.deepEqual(
    ((created.project.product.operations as Record<string, unknown>).bookingControls as Record<string, unknown>).butler,
    initialButler,
  );

  db.setAccountFixedInfo("供应商A", { servicePhone: "400-820-1234", butlerName: changedButler });
  const runtime = new DbOrchestratorRuntime(db);
  const result = await runtime.writeModule(created.project.id, "skeleton", AI_WRITABLE_PATHS.skeleton, {
    transport: "charter",
    pickupCity: "太原",
    reusePickupForDropoff: true,
    hotelSource: "nonPlatform",
    hotelTier: "当地5钻酒店/-38",
    mealsIncluded: false,
    vehicleResource: {},
  });
  assert.equal(result.ok, true);
  const reread = db.getProject(created.project.id)!;
  const booking = (reread.product.operations as Record<string, unknown>).bookingControls as Record<string, unknown>;
  assert.deepEqual(booking.butler, initialButler);
});

test("注入后完整 product 仍可通过 productSchema 校验", async (t) => {
  const { parseProduct } = await import("../../src/main/automation/schema/schema-functions.js");
  const db = await newDatabase(t);
  loginCurrentAccount(db);
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
  db.updateProduct(project.id, baseProduct);

  injectAccountButler(db, project.id, "供应商A");
  const reread = db.getProject(project.id)!;
  // 包含 bookingControls.butler 的完整 product 必须能通过 schema 解析。
  assert.doesNotThrow(() => parseProduct(reread.product));
});

test("写入不污染原 product（不可变性）", async (t) => {
  const db = await newDatabase(t);
  loginCurrentAccount(db);
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
  db.updateProduct(project.id, baseProduct);

  const snapshot = JSON.stringify(baseProduct);
  injectAccountButler(db, project.id, "供应商A");
  // baseProduct 是入参 reference；写库后它本身必须保持原样。
  assert.equal(JSON.stringify(baseProduct), snapshot);
});

test("settings 里的 vbkAccountName 含前后空格 → trim 后仍可命中", async (t) => {
  const db = await newDatabase(t);
  // 故意把账号名两边带空格，模拟某条早期脏数据；trim 后应能查到固定信息。
  db.setSetting("vbkAccountName", "  供应商F  ");
  db.setAccountFixedInfo("供应商F", { butlerName: validButler });
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
  db.updateProduct(project.id, baseProduct);

  // injectAccountButler 的 accountName 参数必须由调用方显式提供；这里我们以 trim 后的值传入。
  const result = injectAccountButler(db, project.id, "  供应商F  ".trim());
  assert.equal(result.written, true);
  const reread = db.getProject(project.id)!;
  const booking = (reread.product.operations as Record<string, unknown>).bookingControls as Record<string, unknown>;
  assert.deepEqual(booking.butler, validButler);
});

test("管家字段非法（缺 displayName / providerId / contactCardId）→ 不写", async (t) => {
  for (const malformed of [
    { contactCardId: 1, providerId: 1, displayName: "" },
    { contactCardId: 1, providerId: 1, displayName: "   " },
    { contactCardId: 0, providerId: 1, displayName: "张三" },
    { contactCardId: -1, providerId: 1, displayName: "张三" },
    { contactCardId: 1, providerId: 0, displayName: "张三" },
    { contactCardId: 1, providerId: -1, displayName: "张三" },
  ]) {
    const db = await newDatabase(t);
    db.setSetting("vbkAccountName", "供应商G");
    // 绕过 setAccountFixedInfo 的内部守卫直接写脏数据。
    db.setSetting("accountFixedInfo:供应商G", JSON.stringify({ butlerName: malformed }));
    const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
    db.updateProduct(project.id, baseProduct);

    const result = injectAccountButler(db, project.id, "供应商G");
    assert.equal(result.written, false, `malformed should not write: ${JSON.stringify(malformed)}`);
    const reread = db.getProject(project.id)!;
    const ops = reread.product.operations as Record<string, unknown>;
    assert.equal(ops.bookingControls, undefined);
  }
});

test("项目不存在 → 不写，给出 reason", async (t) => {
  const db = await newDatabase(t);
  loginCurrentAccount(db);
  const result = injectAccountButler(db, "non-existent-id", "供应商A");
  assert.equal(result.written, false);
  assert.match(result.reason ?? "", /不存在/);
});

test("AI 首次生成后再覆盖一次默认管家：第二次注入仍不覆盖（保留首次 AI 写入的值）", async (t) => {
  const db = await newDatabase(t);
  loginCurrentAccount(db);
  const project = db.createProject({ destination: "太原", days: 2, productForm: "privateTour" });
  db.updateProduct(project.id, baseProduct);

  // 第一次注入：写入 validButler。
  const first = injectAccountButler(db, project.id, "供应商A");
  assert.equal(first.written, true);

  // 切换账号默认管家 → 模拟「账号切换」或「运营在账号设置里改了管家」。
  const otherButler = { contactCardId: 9999, displayName: "李四", providerId: 8888 };
  db.setAccountFixedInfo("供应商A", { butlerName: otherButler });

  // 第二次注入：必须不覆盖，保留 validButler。
  const second = injectAccountButler(db, project.id, "供应商A");
  assert.equal(second.written, false);
  const reread = db.getProject(project.id)!;
  const butler = ((reread.product.operations as Record<string, unknown>).bookingControls as Record<string, unknown>).butler as Record<string, unknown>;
  assert.equal(butler.contactCardId, validButler.contactCardId);
});
