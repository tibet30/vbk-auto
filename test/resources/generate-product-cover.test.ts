import test from "node:test";
import assert from "node:assert/strict";
import { generateProductCover } from "../../src/main/operations/generate-product-cover.js";
import { ProductMutationService } from "../../src/main/application/product-mutation-service.js";
import { ProductWorkflowCoordinator } from "../../src/main/application/product-workflow-coordinator.js";
import type { MainIpcContext } from "../../src/main/ipc/context.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

const original = { source: "manualUpload", fileId: "original", originalName: "original.png", poi: "西安" };
const generated = { ...original, fileId: "generated", generation: { provider: "minimax" } };
function setup() {
  let saved = { id: "p", productJsonVersion: 0, product: { basicInfo: { meetingCity: "西安" },
    itinerary: [], presentation: { cover: original, preservedManualCovers: [{ ...original }] } } } as unknown as ProductDetail;
  const instructions: string[] = [];
  const db = { getProduct: () => saved, updateProduct: (_id: string, product: Record<string, unknown>) => {
    saved = { ...saved, product, productJsonVersion: (saved.productJsonVersion ?? 0) + 1 } as ProductDetail;
  } };
  const context = { db, productWorkflows: new ProductWorkflowCoordinator(),
    productMutations: new ProductMutationService(db), emitProduct: () => {},
    agentCore: { send: async (_id: string, instruction: string) => { instructions.push(instruction); } },
  } as unknown as MainIpcContext;
  return { context, instructions, read: () => saved, change: () => db.updateProduct("p", { ...saved.product,
    basicInfo: { meetingCity: "成都" } }) };
}

test("显式 AI 生成保存新图、保留原图且不重复归档，并重新请求本地审批", async () => {
  const s = setup();
  await generateProductCover(s.context, "p", async product => {
    assert.equal((product.basicInfo as any).meetingCity, "西安");
    return generated;
  });
  const presentation = s.read().product.presentation as any;
  assert.equal(presentation.cover.fileId, "generated");
  assert.deepEqual(presentation.preservedManualCovers, [original]);
  assert.equal(s.instructions.length, 1);
  assert.match(s.instructions[0], /重新请求本次审批/);
  assert.match(s.instructions[0], /禁止携程写入/);
});

test("生成失败或期间产品变化均保留当前封面，不发起审批", async () => {
  const failed = setup();
  await assert.rejects(generateProductCover(failed.context, "p", async () => { throw new Error("余额不足"); }), /余额不足/);
  assert.deepEqual((failed.read().product.presentation as any).cover, original);
  assert.equal(failed.instructions.length, 0);
  const changed = setup();
  await assert.rejects(generateProductCover(changed.context, "p", async () => {
    changed.change(); return generated;
  }), /产品已变更/);
  assert.deepEqual((changed.read().product.presentation as any).cover, original);
  assert.equal(changed.instructions.length, 0);
});

test("重复生成被主进程互斥拦截，不重复调用供应商", async () => {
  const s = setup();
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const first = generateProductCover(s.context, "p", async () => { await waiting; return generated; });
  await assert.rejects(generateProductCover(s.context, "p", async () => { throw new Error("不应调用"); }), /正在进行中/);
  release(); await first;
  assert.equal(s.instructions.length, 1);
});
