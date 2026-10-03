import { runDatabaseMigrations } from "../../src/main/infrastructure/database/parts/migration-registry.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { applyAutoCoverFill, applyCoverFallback } from "../../src/main/operations/cover-auto-fill.js";
import { applyManualReviewField } from "../../src/main/operations/manual-review-field.js";
import { readActiveCoverFallback } from "../../src/shared/cover-fallback.js";
import { placeholderDraftOnly } from "../../src/shared/cover-fallback.js";
import { loadPlaceholderCoverAsset } from "../../src/main/automation/placeholder-cover-asset.js";
import { automationBlockers } from "../../src/main/automation/schema/schema-functions.js";
import { assertPresentationReadyForVbk, evaluateAutomationContract } from "../../src/main/automation/automation-contract.js";
import { listProducts } from "../../src/main/infrastructure/database/parts/products.js";

const product = {
  presentation: {
    recommendation: "推荐",
    features: "特色",
    recommendations: [
      { category: "优选行程", text: "一日私家串联晋祠与太原景点，行程清晰不赶路，体验山西人文历史" },
      { category: "精选酒店", text: "精选当地住宿便利景点与餐饮，方便每日出行与休息，整体体验更舒适" },
      { category: "缤纷景点", text: "覆盖晋祠等太原周边景点，兼顾古建与美食，城市漫游内容更丰富完整" },
    ],
    cover: { source: "ctripLibrary", poi: "晋祠博物馆" },
  },
  itinerary: [{ day: 1, spots: [{ name: "晋祠博物馆", poiName: "晋祠博物馆", poiId: 1 }] }],
};

test("无合格图片创建持久化交接标记，再次检查不重复", async () => {
  const first = await applyAutoCoverFill({
    page: {} as never,
    product,
    now: () => "2026-09-29T00:00:00.000Z",
    injectSearch: async () => ({ keyword: "晋祠博物馆", poi: "", candidates: [], fetchedAt: "2026-09-29T00:00:00.000Z" }),
  });
  assert.equal(first.outcome.written, true);
  assert.equal(readActiveCoverFallback(first.nextProduct)?.reason, "no_qualified_candidate");
  const second = await applyAutoCoverFill({
    page: {} as never,
    product: first.nextProduct,
    injectSearch: async () => ({ keyword: "晋祠博物馆", poi: "", candidates: [], fetchedAt: "2026-09-29T00:00:00.000Z" }),
  });
  assert.equal(second.outcome.written, false);
  assert.equal(second.nextProduct, first.nextProduct);
  assert.equal(placeholderDraftOnly(first.nextProduct), false);
  assert.throws(() => assertPresentationReadyForVbk(first.nextProduct), /未提审/);
  const draft = { ...first.nextProduct, commercial: { release: { submitReview: false, publishAfterApproval: false } } };
  assert.equal(placeholderDraftOnly(draft), true);
  assert.equal(evaluateAutomationContract(draft).failures.some((item) => item.field.path === "presentation.cover"), false);
  assert.equal(automationBlockers(draft).some((item) => item.label === "封面图"), false);
  assert.doesNotThrow(() => assertPresentationReadyForVbk(draft));
  const publish = { ...draft, commercial: { release: { submitReview: false, publishAfterApproval: true } } };
  assert.equal(placeholderDraftOnly(publish), false);
  assert.equal(automationBlockers(publish).some((item) => item.label === "封面图"), true);
  assert.throws(() => assertPresentationReadyForVbk(publish), /未上架/);
});

test("图库图片有 ID 但尺寸或质量不足时仍进入占位交接", async () => {
  const filled = await applyAutoCoverFill({
    page: {} as never,
    product,
    injectSearch: async () => ({
      keyword: "晋祠博物馆", poi: "", fetchedAt: "2026-09-29T00:00:00.000Z",
      candidates: [
        { stableId: "small", index: 0, quality: "4.8", resolution: "900*600", imageId: 11, imageUrl: "https://example.test/small", imageResolved: true, poiId: 1 },
        { stableId: "low", index: 1, quality: "2.5", resolution: "1600*1000", imageId: 12, imageUrl: "https://example.test/low", imageResolved: true, poiId: 1 },
      ],
    }),
  });
  assert.equal(readActiveCoverFallback(filled.nextProduct)?.reason, "no_qualified_candidate");
  assert.equal((filled.nextProduct.presentation as Record<string, unknown>).cover, product.presentation.cover);
});

test("图库故障与无合格图分开记录；人工上传后占位消失", () => {
  const unavailable = applyCoverFallback(product, "search_unavailable", () => "2026-09-29T00:00:00.000Z");
  assert.equal(readActiveCoverFallback(unavailable.nextProduct)?.reason, "search_unavailable");
  const saved = applyManualReviewField(unavailable.nextProduct, {
    field: "productCover",
    cover: {
      source: "manualUpload", fileId: "local-cover", originalName: "cover.jpg", mimeType: "image/jpeg",
      sizeBytes: 4096, uploadedAt: "2026-09-29T01:00:00.000Z", poi: "晋祠博物馆",
      description: "人工封面", minQuality: 3,
    },
  });
  assert.equal(readActiveCoverFallback(saved), null);
  assert.equal((saved.presentation as Record<string, unknown>).coverFallback, undefined);
  assert.equal(applyCoverFallback(saved, "no_qualified_candidate").written, false);
});

test("运营占位资源符合 VBK 上传尺寸并可作为内存文件载入", () => {
  const data = readFileSync("src/renderer/assets/cover-fallback.png");
  assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.ok(data.readUInt32BE(16) >= 1280);
  assert.ok(data.readUInt32BE(20) >= 800);
  assert.ok(data.length < 8 * 1024 * 1024);
  const uploaded = loadPlaceholderCoverAsset(process.cwd());
  assert.equal(uploaded.name, "draft-fallback-cover-v2.png");
  assert.deepEqual(uploaded.buffer, data);
});

test("数据库读回后产品列表标出待换图，真实封面不再标记", () => {
  const db = new Database(":memory:");
  try {
    runDatabaseMigrations(db);
    const insert = db.prepare("INSERT INTO products(id,name,status,product_id,product_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'2026-09-29')");
    const fallback = applyCoverFallback(product, "no_qualified_candidate").nextProduct;
    insert.run("needs-cover", "待换封面", "review", null, JSON.stringify(fallback), "2026-09-29");
    insert.run("has-cover", "已有封面", "review", null, JSON.stringify({
      presentation: { ...fallback.presentation as Record<string, unknown>, cover: {
        source: "manualUpload", fileId: "saved-file", originalName: "cover.jpg",
      } },
    }), "2026-09-29");
    const items = listProducts(db);
    assert.equal(items.find((item) => item.id === "needs-cover")?.coverNeedsReplacement, true);
    assert.equal(items.find((item) => item.id === "has-cover")?.coverNeedsReplacement, undefined);
  } finally {
    db.close();
  }
});
