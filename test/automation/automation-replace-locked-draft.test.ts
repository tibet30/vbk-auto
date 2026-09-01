import assert from "node:assert/strict";
import test from "node:test";
import { assertRemoteDraftCanBeReplaced, prepareLockedDraftReplacement } from "../../src/main/automation/automation.main/automation.main.replace-locked-draft.js";

const failedLongDraft: any = {
  id: "local-1", name: "北京7天6晚", status: "blocked", productId: "77866144", basicInfoSaved: true,
  product: { sales: { productType: "domesticLong", productForm: "privateTour" } },
  messages: [], researchTasks: [], automation: { id: "run-1", status: "failed", phases: [], logs: [] },
};

test("锁定的失败境内长线草稿只准备替代品，不删除旧草稿", () => {
  const result = prepareLockedDraftReplacement(failedLongDraft);
  assert.equal(result.previousProductId, "77866144");
  assert.equal((result.replacementProduct.sales as any).productType, "domesticShort");
  assert.equal(failedLongDraft.product.sales.productType, "domesticLong");
});

test("未失败或非旧版长线草稿不能被替代", () => {
  assert.throws(() => prepareLockedDraftReplacement({ ...failedLongDraft, status: "review" }), /仅允许替代/);
  assert.throws(() => prepareLockedDraftReplacement({ ...failedLongDraft, product: { sales: { productType: "domesticShort" } } }), /旧版境内长线/);
});

test("替代前必须确认远端仍是未提审、未激活的境内长线草稿", () => {
  const remote = { data: { saleControlInfo: { productCategoryID: 10 }, baseInfo: { active: "F" }, meta: { auditStatus: "N", releaseActive: "F" } } };
  assert.doesNotThrow(() => assertRemoteDraftCanBeReplaced(remote));
  assert.throws(() => assertRemoteDraftCanBeReplaced({ ...remote, data: { ...remote.data, meta: { auditStatus: "A", releaseActive: "F" } } }), /不满足安全替代条件/);
});
