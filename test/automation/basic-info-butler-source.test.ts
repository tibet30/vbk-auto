/**
 * 自动化 basic 阶段的负责人来源：
 *  - 管家联系人只读 product.operations.bookingControls.butler；
 *  - 400 电话仍从当前账号固定信息读取；
 *  - 账号默认管家后续变化不能影响已创建产品 JSON。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import {
  refreshSupplierProductCodeForPlatformWrite,
  resolveActiveServicePhoneContext,
  resolveProductButlerSelection,
} from "../../src/main/automation/automation.main/automation.main.class.helpers.js";

async function newDatabase(t: test.TestContext) {
  const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), "vbk-basic-butler-source-"));
  t.after(() => fs.rm(dataPath, { recursive: true, force: true }));
  return new VbkDatabase(dataPath);
}

test("resolveProductButlerSelection 只读取 product JSON 中已固化的负责人", () => {
  const productButler = { contactCardId: 1753732, displayName: " 张三 ", providerId: 1279416 };
  const product = {
    operations: {
      bookingControls: {
        butler: productButler,
      },
    },
  };

  assert.deepEqual(resolveProductButlerSelection(product), {
    contactCardId: 1753732,
    displayName: "张三",
    providerId: 1279416,
  });
});

test("resolveProductButlerSelection 拒绝缺 ID 或空名称的负责人", () => {
  assert.equal(resolveProductButlerSelection({}), null);
  assert.equal(resolveProductButlerSelection({
    operations: { bookingControls: { butler: { contactCardId: 1, displayName: "", providerId: 1 } } },
  }), null);
  assert.equal(resolveProductButlerSelection({
    operations: { bookingControls: { butler: { contactCardId: 1, displayName: "张三" } } },
  }), null);
});

test("系统供应商产品编号在 basic 实际写入前即时生成并绑定平台产品 ID", () => {
  const product = {
    basicInfo: { supplierProductCode: "VBK-安思科" },
    operations: { bookingControls: { butler: { contactCardId: 1368298, displayName: "安思科", providerId: 1279416 } } },
  };
  const butler = resolveProductButlerSelection(product);

  const upgraded = refreshSupplierProductCodeForPlatformWrite(product, butler, "77634579");

  assert.match(String(upgraded), /^VBK-安思科-\d{17,}-P77634579$/);
  assert.equal((product.basicInfo as Record<string, unknown>).supplierProductCode, upgraded);
});

test("已绑定系统编号也会在下一次平台写入前刷新，手工编号保持不动", () => {
  const butler = { contactCardId: 1368298, displayName: "安思科", providerId: 1279416 };
  const withProductId = { basicInfo: { supplierProductCode: "VBK-安思科-20260823123456789-P77634579" } };
  const manual = { basicInfo: { supplierProductCode: "TY-REAL-001" } };

  const refreshed = refreshSupplierProductCodeForPlatformWrite(withProductId, butler, "77634579");
  assert.match(String(refreshed), /^VBK-安思科-\d{17,}-P77634579$/);
  assert.notEqual(refreshed, "VBK-安思科-20260823123456789-P77634579");
  assert.equal(withProductId.basicInfo.supplierProductCode, refreshed);
  assert.equal(refreshSupplierProductCodeForPlatformWrite(manual, butler, "77634579"), null);
  assert.equal(manual.basicInfo.supplierProductCode, "TY-REAL-001");
});

test("同一产品连续两次写入前都会得到不同的当前编号", () => {
  const product = { basicInfo: { supplierProductCode: "VBK-安思科" } };
  const butler = { contactCardId: 1368298, displayName: "安思科", providerId: 1279416 };

  const first = refreshSupplierProductCodeForPlatformWrite(product, butler, "77634579");
  const second = refreshSupplierProductCodeForPlatformWrite(product, butler, "77634579");

  assert.notEqual(first, second);
  assert.equal(product.basicInfo.supplierProductCode, second);
});

test("相同旧编号在本次写入时绑定不同平台产品 ID 后必然不同", () => {
  const product = { basicInfo: { supplierProductCode: "VBK-安思科-20260827023049064" } };
  const butler = { contactCardId: 1368298, displayName: "安思科", providerId: 1279416 };

  const replacement = refreshSupplierProductCodeForPlatformWrite(product, butler, "77634579");
  const another = refreshSupplierProductCodeForPlatformWrite(
    { basicInfo: { supplierProductCode: "VBK-安思科-20260827023049064" } }, butler, "77631395",
  );

  assert.match(String(replacement), /^VBK-安思科-\d{17,}-P77634579$/);
  assert.match(String(another), /^VBK-安思科-\d{17,}-P77631395$/);
  assert.notEqual(replacement, another);
  assert.equal(product.basicInfo.supplierProductCode, replacement);
});

test("400 电话可独立读取，不再要求账号固定信息仍有 butlerName", async (t) => {
  const db = await newDatabase(t);
  db.setSetting("vbkAccountName", "供应商A");
  db.setAccountFixedInfo("供应商A", { servicePhone: "400-820-1234" });

  assert.deepEqual(resolveActiveServicePhoneContext(db, "供应商A"), {
    accountName: "供应商A",
    servicePhone: "400-820-1234",
    fallbackUsed: false,
  });
});

test("400 电话优先按当前活动的规范 VBK 账号键读取，不把展示名当账号键", async (t) => {
  const db = await newDatabase(t);
  db.setSetting("vbkAccountName", "小璐");
  db.setSetting("vbkActiveAccountKey", "vbk_671205");
  db.setExtensionUserIdResolver(() => 3);
  db.setAccountFixedInfo("3:vbk_671205", { servicePhone: "0609240" });

  assert.deepEqual(resolveActiveServicePhoneContext(db, "小璐"), {
    accountName: "vbk_671205",
    servicePhone: "0609240",
    fallbackUsed: false,
  });
});
