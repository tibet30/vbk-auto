import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyAutoCoverFill } from "../../src/main/operations/cover-auto-fill.js";
import { inspectManualCoverAsset } from "../../src/main/automation/manual-cover-asset.js";
import { storeManualCoverFile, retainManualCoverFile, resolveManualCoverPath } from "../../src/main/infrastructure/database/parts/cover-storage.js";
import { presentationSchema } from "../../src/main/automation/schema/schema-definitions/presentation.js";

function fixture(width = 1200, height = 800) {
  const dataPath = mkdtempSync(path.join(os.tmpdir(), "manual-cover-recovery-"));
  const bytes = readFileSync(new URL("../fixtures/product-regression/xian-cover.png", import.meta.url));
  const meta = storeManualCoverFile({ dataPath, originalName: "original.png", mimeType: "image/png", bytes });
  retainManualCoverFile({ dataPath, fileId: meta.fileId });
  const cover = { source: "manualUpload", ...meta, poi: "张良庙", description: "用户原图", minQuality: 3 };
  const product = { presentation: { cover }, itinerary: [{ day: 1, spots: [{ name: "张良庙", poiName: "张良庙", poiId: 79410 }] }] };
  const inspect: typeof inspectManualCoverAsset = value => inspectManualCoverAsset(value, dataPath, () => ({ width, height }));
  return { product, cover, inspect, bytes, originalPath: resolveManualCoverPath({ dataPath, fileId: meta.fileId, originalName: meta.originalName })! };
}

const candidate = { stableId: "library", index: 0, imageId: 11, imageUrl: "https://example.test/library.jpg", imageResolved: true,
  quality: "4.8", resolution: "1600*1000", poiId: 79410, poiName: "张良庙" };

function search(candidates = [candidate]) {
  return async (_page: unknown, keyword: string) => ({ keyword, poi: keyword, candidates, fetchedAt: "2026-10-11T00:00:00Z" });
}

test("尺寸不足的手动封面换用合格图库图并持久化原图引用，不删除本地原图", async () => {
  const f = fixture();
  assert.equal(f.inspect(f.product).reason, "dimensions");
  const result = await applyAutoCoverFill({ page: {} as never, product: f.product, inspectManualCover: f.inspect, injectSearch: search() });
  assert.equal(result.outcome.written, true);
  const saved = presentationSchema.parse(result.nextProduct.presentation);
  assert.equal(saved.cover?.source, "ctripLibrary");
  assert.equal(saved.cover?.description, "张良庙");
  assert.equal(saved.cover?.source === "ctripLibrary" && saved.cover.imageId, 11);
  assert.deepEqual(saved.preservedManualCovers, [f.cover]);
  assert.deepEqual(readFileSync(f.originalPath), f.bytes);
  assert.equal(f.inspect(result.nextProduct).issue, null);
  assert.match(result.outcome.reason!, /重新审批/);
});

test("合格横版和竖版手动封面保持用户选择，不查询图库", async () => {
  for (const [width, height] of [[1280, 800], [800, 1280]]) {
    const f = fixture(width, height);
    const result = await applyAutoCoverFill({ page: {} as never, product: f.product, inspectManualCover: f.inspect,
      injectSearch: async () => { throw new Error("不应查询"); } });
    assert.equal(result.nextProduct, f.product);
    assert.equal(result.outcome.written, false);
  }
});

test("图库空结果、低质、小图、地域错误或查询失败均保留手动原图与尺寸阻塞", async () => {
  for (const injectSearch of [search([]), search([{ ...candidate, quality: "2" }]), search([{ ...candidate, resolution: "1200*800" }]),
    search([{ ...candidate, poiId: 42, poiName: "外省景点" }]), async () => { throw new Error("网络不可用"); }]) {
    const f = fixture();
    const result = await applyAutoCoverFill({ page: {} as never, product: f.product, inspectManualCover: f.inspect, injectSearch });
    assert.equal(result.nextProduct, f.product);
    assert.equal(result.outcome.written, false);
    assert.equal(f.inspect(result.nextProduct).reason, "dimensions");
    assert.equal((result.nextProduct.presentation as Record<string, unknown>).coverFallback, undefined);
    assert.deepEqual(readFileSync(f.originalPath), f.bytes);
  }
});

test("文件未核验或失效不能被当作尺寸不足而替换", async () => {
  const f = fixture();
  const result = await applyAutoCoverFill({ page: {} as never, product: f.product,
    inspectManualCover: () => ({ asset: null, issue: "文件失效" }), injectSearch: search() });
  assert.equal(result.nextProduct, f.product);
  assert.equal(result.outcome.written, false);
});
