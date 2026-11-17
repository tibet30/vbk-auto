import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VbkDatabase } from "../../src/main/infrastructure/database/database.js";
import { buildVbkWritePortFromContext } from "../../src/main/agent-workspace/vbk-write-adapter.js";
import type { MainIpcContext } from "../../src/main/ipc/context.js";
import type { ItineraryReviewUnlockState } from "../../src/shared/itinerary-review-unlock.js";

const OWNER = 1001;

function seededDb(): { db: VbkDatabase; localProductId: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vbk-write-gate-"));
  const db = new VbkDatabase(path.join(dir, "data"));
  const product = db.createProduct({
    destination: "日喀则",
    days: 2,
    productForm: "privateTour",
    userIdea: "日喀则2天1晚私家团",
  } as never);
  return { db, localProductId: product.id };
}

function unlockState(localProductId: string, overrides: Partial<ItineraryReviewUnlockState> = {}): ItineraryReviewUnlockState {
  return {
    localProductId,
    status: "verified",
    attemptId: "attempt-1",
    approvalId: "approval-1",
    productId: "80664603",
    accountKey: "vbk_671205",
    tourInfoId: "tour-1",
    beforeDigest: "a".repeat(64),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function contextFor(
  db: VbkDatabase,
  readiness: { ready: boolean; completion: number; issues: Array<{ label: string; detail: string }> },
): MainIpcContext {
  return {
    db,
    readiness: () => readiness,
  } as unknown as MainIpcContext;
}

test("门禁：产品不存在 / 未回填 VBK id 时都拒绝", async () => {
  const { db, localProductId } = seededDb();
  const port = buildVbkWritePortFromContext(contextFor(db, { ready: true, completion: 100, issues: [] }));

  const missing = await port.gate("no-such-product");
  assert.equal(missing.allowed, false);
  assert.match(missing.reason ?? "", /本地产品不存在/u);

  const noVbkId = await port.gate(localProductId);
  assert.equal(noVbkId.allowed, false);
  assert.match(noVbkId.reason ?? "", /还没有回填 VBK 产品 id/u);
});

test("门禁：程序检查未通过时拒绝，并带出前三条阻塞项", async () => {
  const { db, localProductId } = seededDb();
  db.setProductId(localProductId, "80664603");
  db.saveItineraryReviewUnlockState(unlockState(localProductId));
  const port = buildVbkWritePortFromContext(contextFor(db, {
    ready: false,
    completion: 40,
    issues: [
      { label: "住宿", detail: "缺少逐晚住宿城市" },
      { label: "交通", detail: "未配置班次" },
      { label: "封面", detail: "需要替换" },
      { label: "多余", detail: "不应出现在原因里" },
    ],
  }));
  const result = await port.gate(localProductId);
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /程序检查未通过/u);
  assert.match(result.reason ?? "", /住宿：缺少逐晚住宿城市/u);
  assert.doesNotMatch(result.reason ?? "", /不应出现在原因里/u, "只带前三条，避免刷屏");
});

test("门禁：缺运营确认记录或确认未完成时拒绝", async () => {
  const { db, localProductId } = seededDb();
  db.setProductId(localProductId, "80664603");
  const port = buildVbkWritePortFromContext(contextFor(db, { ready: true, completion: 100, issues: [] }));

  const none = await port.gate(localProductId);
  assert.equal(none.allowed, false);
  assert.match(none.reason ?? "", /尚未完成运营确认/u);

  db.saveItineraryReviewUnlockState(unlockState(localProductId, { status: "requires_review" }));
  const notVerified = await port.gate(localProductId);
  assert.equal(notVerified.allowed, false);
  assert.match(notVerified.reason ?? "", /requires_review/u);

  db.saveItineraryReviewUnlockState(unlockState(localProductId, { approvalId: undefined }));
  const noApproval = await port.gate(localProductId);
  assert.equal(noApproval.allowed, false, "verified 但没有 approvalId 不算运营确认");
});

test("门禁：三道门禁都通过时给出后台账号、VBK 产品 id 与确认凭据", async () => {
  const { db, localProductId } = seededDb();
  db.setProductId(localProductId, "80664603");
  db.saveItineraryReviewUnlockState(unlockState(localProductId));
  const port = buildVbkWritePortFromContext(contextFor(db, { ready: true, completion: 100, issues: [] }));

  const result = await port.gate(localProductId);
  assert.deepEqual(result, {
    allowed: true,
    accountKey: "vbk_671205",
    vbkProductId: "80664603",
    confirmationId: "approval-1",
  });
});

test("批准后门禁被推翻时，执行阶段重新校验并拒绝写入", async () => {
  const { db, localProductId } = seededDb();
  db.setProductId(localProductId, "80664603");
  db.saveItineraryReviewUnlockState(unlockState(localProductId));
  let ready = true;
  const port = buildVbkWritePortFromContext({
    db,
    readiness: () => ({ ready, completion: ready ? 100 : 30, issues: ready ? [] : [{ label: "住宿", detail: "被改回未确认" }] }),
  } as unknown as MainIpcContext);

  // 计划阶段：门禁通过
  assert.equal((await port.gate(localProductId)).allowed, true);

  // 批准前产品被改回未通过状态
  ready = false;
  const afterChange = await port.gate(localProductId);
  assert.equal(afterChange.allowed, false);
  assert.match(afterChange.reason ?? "", /程序检查未通过/u);

  // 写入执行阶段同样会重新解析目标（target 内再跑一次门禁），因此不会发生写入
  const skill = (await import("../../src/main/agent-runtime/index.js")).createVbkWriteSkill(port);
  await assert.rejects(
    () => skill.actions[0].target({ productId: localProductId }, { ownerUserId: OWNER, threadId: "t", runId: "r" }),
    /产品门禁未通过，拒绝写入/u,
  );
});
