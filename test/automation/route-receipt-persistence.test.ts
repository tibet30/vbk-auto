import test from "node:test";
import assert from "node:assert/strict";
import { writeAutomationProduct } from "../../src/main/automation/automation.main/automation.main.persist.js";
import { productReport, sameProductReport } from "../../src/main/infrastructure/product-report.js";
import { productJsonSaveStatus } from "../../src/main/operations/product-json-save-policy.js";
import { hasVerifiedRouteAdministrativeNode } from "../../src/shared/route-administrative-nodes.js";
import type { AutomationRunContext } from "../../src/main/automation/automation.main/automation.main.context.js";
import type { ProductDetail } from "../../src/shared/contracts.js";
const node = { day: 2, name: "德令哈", districtId: 891 };
const current = { basicInfo: { meetingCity: "西宁" }, diagnostics: { creationInput: { destination: "西宁" }, routeAdministrativeNodes: [node], runtime: { status: "running" } } };

test("平台解析后的保存保留最新本地行政节点凭证，两条写入路径一致", () => {
  for (const withService of [true, false]) {
    let saved: Record<string, unknown> = {};
    const persist = (_id: string, product: Record<string, unknown>) => { saved = product; };
    const ctx = { db: { getProduct: () => ({ product: current }), updateProduct: persist }, ...(withService ? { persistProduct: persist } : {}) } as unknown as AutomationRunContext;
    writeAutomationProduct(ctx, "fresh", { basicInfo: { meetingCity: "西宁" }, diagnostics: { runtime: { status: "stale" } } }, "draft_saved");
    assert.equal(hasVerifiedRouteAdministrativeNode(saved, "德令哈", 2), true);
    assert.equal((saved.diagnostics as any).runtime.status, "running");
    assert.deepEqual((saved.diagnostics as any).creationInput, current.diagnostics.creationInput);
  }
});
test("行政核验凭证跨产品同步保留，不能只当本地日志裁掉", () => {
  const detail = { id: "fresh", status: "draft_saved", name: "西宁", product: current, messages: [], researchTasks: [] } as unknown as ProductDetail;
  const report = productReport(detail);
  assert.equal(hasVerifiedRouteAdministrativeNode(report.product, "德令哈", 2), true);
  assert.equal(sameProductReport(detail, { ...detail, product: { ...current, diagnostics: { routeAdministrativeNodes: [] } } }), false);
});
test("只恢复核验元数据保留完成状态，业务内容修改仍回到审查", () => {
  const { diagnostics: _metadata, ...business } = current;
  assert.equal(productJsonSaveStatus(business, current, "draft_saved"), "draft_saved");
  assert.equal(productJsonSaveStatus(current, { ...current, basicInfo: { meetingCity: "敦煌" } }, "draft_saved"), "review");
});
