import test from "node:test";
import assert from "node:assert/strict";
import { coverReadyForAutomation, deriveManualCoverFields, readCover } from "../../src/main/operations/cover-info.js";

const baseProduct = {
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
  presentation: {
    recommendation: "推荐",
    features: "特色",
  },
  operations: { transport: "charter", pickupCity: "太原" },
  itinerary: [{ day: 1 }],
};

test("readCover 在无 presentation 时返回 null", () => {
  assert.equal(readCover(baseProduct), null);
});

test("readCover 在 ctripLibrary 时返回归一化数据", () => {
  const product = {
    ...baseProduct,
    presentation: {
      ...baseProduct.presentation,
      cover: { source: "ctripLibrary", poi: "云冈石窟", description: "横版", minQuality: 3 },
    },
  };
  const cover = readCover(product);
  assert.deepEqual(cover, { source: "ctripLibrary", poi: "云冈石窟", description: "横版", minQuality: 3 });
});

test("readCover 在 manualUpload 时要求 fileId", () => {
  const product = {
    ...baseProduct,
    presentation: {
      ...baseProduct.presentation,
      cover: {
        source: "manualUpload",
        fileId: "11111111-1111-1111-1111-111111111111",
        originalName: "demo.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1024,
        poi: "云冈石窟",
        description: "横版",
        minQuality: 3,
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  };
  const cover = readCover(product);
  assert.ok(cover);
  assert.equal(cover?.source, "manualUpload");
  assert.equal(cover?.fileId, "11111111-1111-1111-1111-111111111111");
});

test("readCover 在缺 POI / 描述时返回 null", () => {
  const product = {
    ...baseProduct,
    presentation: {
      ...baseProduct.presentation,
      cover: { source: "ctripLibrary", poi: "", description: "y", minQuality: 3 },
    },
  };
  assert.equal(readCover(product), null);
});

test("coverReadyForAutomation 在 manualUpload 时阻断", () => {
  const product = {
    ...baseProduct,
    presentation: {
      ...baseProduct.presentation,
      cover: {
        source: "manualUpload",
        fileId: "11111111-1111-1111-1111-111111111111",
        originalName: "demo.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 1024,
        poi: "云冈石窟",
        description: "横版",
        minQuality: 3,
        uploadedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  };
  const result = coverReadyForAutomation(product);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "manualUploadNotSupported");
});

test("coverReadyForAutomation 在 ctripLibrary 时返回 ok", () => {
  const product = {
    ...baseProduct,
    presentation: {
      ...baseProduct.presentation,
      cover: { source: "ctripLibrary", poi: "云冈石窟", description: "横版", minQuality: 3 },
    },
  };
  assert.deepEqual(coverReadyForAutomation(product), { ok: true, reason: "ok" });
});

test("coverReadyForAutomation 在无 cover 时返回 missing", () => {
  assert.deepEqual(coverReadyForAutomation(baseProduct), { ok: false, reason: "missing" });
});

test("deriveManualCoverFields 优先沿用旧 cover.poi / description / minQuality", () => {
  const previous = {
    source: "ctripLibrary",
    poi: "旧 POI",
    description: "旧描述",
    minQuality: 4,
  };
  const derived = deriveManualCoverFields({
    previousCover: previous,
    product: baseProduct,
    originalName: "新图片.jpg",
  });
  assert.deepEqual(derived, { poi: "旧 POI", description: "旧描述", minQuality: 4 });
});

test("deriveManualCoverFields 无旧 cover 时回退到 product.basicInfo 城市", () => {
  const derived = deriveManualCoverFields({
    previousCover: null,
    product: baseProduct,
    originalName: "yungang.jpg",
  });
  assert.equal(derived.poi, "太原");
  assert.equal(derived.description, "手动上传：yungang.jpg");
  assert.equal(derived.minQuality, 3);
});

test("deriveManualCoverFields 无城市时回退到文件名（去扩展名）", () => {
  const product = { ...baseProduct, basicInfo: {} };
  const derived = deriveManualCoverFields({
    previousCover: null,
    product,
    originalName: "云冈石窟外景.png",
  });
  assert.equal(derived.poi, "云冈石窟外景");
  assert.equal(derived.description, "手动上传：云冈石窟外景.png");
  assert.equal(derived.minQuality, 3);
});

test("deriveManualCoverFields 旧 minQuality 非法时回退到 3", () => {
  const previous = { source: "manualUpload", poi: "x", description: "y", minQuality: 99 };
  const derived = deriveManualCoverFields({
    previousCover: previous,
    product: baseProduct,
    originalName: "a.jpg",
  });
  assert.equal(derived.minQuality, 3);
});

test("deriveManualCoverFields 全兜底：占位 POI / 描述", () => {
  const derived = deriveManualCoverFields({
    previousCover: null,
    product: { basicInfo: {} },
    originalName: "pic.jpg",
  });
  assert.equal(derived.poi, "pic");
  assert.equal(derived.description, "手动上传：pic.jpg");
});