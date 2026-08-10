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
