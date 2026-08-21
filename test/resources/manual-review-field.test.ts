import test from "node:test";
import assert from "node:assert/strict";
import { applyManualReviewField } from "../../src/main/operations/manual-review-field.js";
import { productSchema } from "../../src/main/automation/schema/schema-definitions.js";

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
  operations: {
    transport: "charter",
    pickupCity: "太原",
    reusePickupForDropoff: true,
    hotelSource: "nonPlatform",
    hotelTier: "当地3钻酒店/-3",
    mealsIncluded: false,
    bookingControls: { advanceBooking: { days: 1, time: "12:00" } },
    vehicleResource: {
      resourceGroupId: 88231,
      resourceGroupName: "太原用车组",
      serviceHoursPerDay: 8,
      serviceKilometersPerDay: 300,
    },
  },
  commercial: {
    packageName: "标准套餐",
    pricing: { currency: "CNY", adult: 1500, child: 1200, minimumTravelers: 2 },
  },
  itinerary: [
    { day: 1, title: "D1", description: "首日", hotel: "太原酒店", meals: "自理", spots: [{ name: "晋祠", poiName: null, poiId: null }, { name: "已有景点", poiName: "已有 POI", poiId: 100 }] },
    { day: 2, title: "D2", description: "次日", hotel: "", meals: "自理", spots: [{ name: "山西博物院", poiName: null, poiId: null }] },
  ],
  presentation: {
    recommendation: "云冈石窟外景横版是产品首图首选。",
    features: ["一日游", "私家团"],
  },
};

test("手动调整成人儿童估价与起订人数时保留 cost", () => {
  const product = {
    commercial: {
      pricing: {
        currency: "CNY",
        adult: 1500,
        child: 1200,
        minimumTravelers: 2,
        cost: { adult: 1100, child: 800, singleSupplement: 300, childBed: 200 },
      },
    },
  };
  const next = applyManualReviewField(product, { field: "pricing", adult: 1680, child: 980, minimumTravelers: 3 });
  assert.deepEqual((next.commercial as Record<string, unknown>).pricing, {
    currency: "CNY",
    adult: 1680,
    child: 980,
    minimumTravelers: 3,
    cost: { adult: 1100, child: 800, singleSupplement: 300, childBed: 200 },
  });
  assert.equal(((product.commercial.pricing) as { adult: number }).adult, 1500);
});

test("手动调整会拒绝无效价格", () => {
  assert.throws(() => applyManualReviewField({}, { field: "pricing", adult: 0, child: 100, minimumTravelers: 2 }), /成人价/);
  assert.throws(() => applyManualReviewField({}, { field: "pricing", adult: 1000, child: -1, minimumTravelers: 2 }), /儿童价/);
  assert.throws(() => applyManualReviewField({}, { field: "pricing", adult: Number.NaN, child: 0, minimumTravelers: 2 }), /成人价/);
});

test("起订人数必须是正整数，否则拒绝", () => {
  assert.throws(() => applyManualReviewField({}, { field: "pricing", adult: 1000, child: 0, minimumTravelers: 0 }), /起订人数/);
  assert.throws(() => applyManualReviewField({}, { field: "pricing", adult: 1000, child: 0, minimumTravelers: -1 }), /起订人数/);
  assert.throws(() => applyManualReviewField({}, { field: "pricing", adult: 1000, child: 0, minimumTravelers: 1.5 }), /起订人数/);
  assert.throws(() => applyManualReviewField({}, { field: "pricing", adult: 1000, child: 0, minimumTravelers: Number.NaN }), /起订人数/);
});

test("旧产品 pricing 缺少 minimumTravelers 时不自动补默认，仅在手动三字段保存后才写入", () => {
  // 模拟历史遗留 pricing：只有 adult / child，没有 minimumTravelers。
  const product = { commercial: { pricing: { currency: "CNY", adult: 1500, child: 1200 } } };
  // 直接套 applyManualReviewField 不传 minimumTravelers 会被类型系统拒绝。
  // 运行时等价入口（验证不会默认填补）也仍然以抛错拒绝非法输。
  assert.throws(
    () => applyManualReviewField(product, { field: "pricing", adult: 1500, child: 1200, minimumTravelers: Number.NaN } as never),
    /起订人数/,
  );
  // 手动三字段保存后，pricing 才进入合法状态。
  const next = applyManualReviewField(product, { field: "pricing", adult: 1680, child: 980, minimumTravelers: 2 });
  const pricing = (next.commercial as Record<string, unknown>).pricing as Record<string, unknown>;
  assert.equal(pricing.adult, 1680);
  assert.equal(pricing.child, 980);
  assert.equal(pricing.minimumTravelers, 2);
  // 原 product 未被修改
  assert.equal(((product.commercial.pricing) as Record<string, unknown>).minimumTravelers, undefined);
});

test("手动写入班期库存时写入 commercial.inventory 且不覆盖 pricing / packageName", () => {
  const product = {
    commercial: {
      packageName: "标准套餐",
      pricing: { currency: "CNY", adult: 1680, child: 980, minimumTravelers: 2 },
    },
  };
  const next = applyManualReviewField(product, {
    field: "inventory",
    startDate: "2026-09-01",
    endDate: "2026-09-30",
    dailyQuota: 10,
  });
  const commercial = next.commercial as Record<string, unknown>;
  assert.deepEqual(commercial.inventory, { startDate: "2026-09-01", endDate: "2026-09-30", dailyQuota: 10 });
  assert.equal(commercial.packageName, "标准套餐");
  assert.deepEqual(commercial.pricing, product.commercial.pricing);
  assert.equal((product.commercial as Record<string, unknown>).inventory, undefined);
});

test("手动更新班期库存时只替换 inventory，保留 commercial.pricing", () => {
  const product = {
    commercial: {
      pricing: { currency: "CNY", adult: 1680, child: 980, minimumTravelers: 2 },
      inventory: { startDate: "2026-09-01", endDate: "2026-09-30", dailyQuota: 10 },
    },
  };
  const next = applyManualReviewField(product, {
    field: "inventory",
    startDate: "2026-10-01",
    endDate: "2026-10-31",
    dailyQuota: 6,
  });
  const commercial = next.commercial as Record<string, unknown>;
  assert.deepEqual(commercial.inventory, { startDate: "2026-10-01", endDate: "2026-10-31", dailyQuota: 6 });
  assert.deepEqual(commercial.pricing, product.commercial.pricing);
});

test("手动班期库存拒绝非法日期与配额", () => {
  assert.throws(() => applyManualReviewField({}, {
    field: "inventory",
    startDate: "2026/09/01",
    endDate: "2026-09-30",
    dailyQuota: 10,
  }), /开始日期/);
  assert.throws(() => applyManualReviewField({}, {
    field: "inventory",
    startDate: "2026-09-01",
    endDate: "2026-02-30",
    dailyQuota: 10,
  }), /结束日期/);
  assert.throws(() => applyManualReviewField({}, {
    field: "inventory",
    startDate: "2026-10-01",
    endDate: "2026-09-30",
    dailyQuota: 10,
  }), /不能晚于/);
  assert.throws(() => applyManualReviewField({}, {
    field: "inventory",
    startDate: "2026-09-01",
    endDate: "2026-09-30",
    dailyQuota: 0,
  }), /每日配额/);
  assert.throws(() => applyManualReviewField({}, {
    field: "inventory",
    startDate: "2026-09-01",
    endDate: "2026-09-30",
    dailyQuota: 1.5,
  }), /每日配额/);
});

test("副标题写入保留其它基础信息字段", () => {
  const next = applyManualReviewField(baseProduct, { field: "basicInfoSubtitle", subtitle: "  太原精品两日游  " });
  const basic = (next.basicInfo as Record<string, unknown>);
  assert.equal(basic.subtitle, "太原精品两日游");
  assert.equal(basic.supplierProductName, "太原2天1晚私家团");
  assert.equal(basic.province, "山西");
  // 不污染原对象
  assert.equal((baseProduct.basicInfo as Record<string, unknown>).subtitle, "太原经典私家团");
});

test("副标题长度低于 2 字符会被拒绝", () => {
  assert.throws(() => applyManualReviewField(baseProduct, { field: "basicInfoSubtitle", subtitle: "x" }), /副标题/);
});

test("副标题长度超过 80 字符会被拒绝", () => {
  const longText = "x".repeat(81);
  assert.throws(() => applyManualReviewField(baseProduct, { field: "basicInfoSubtitle", subtitle: longText }), /副标题/);
});

test("管家联系人写入完整 ContactCardSelection 并保留 advanceBooking", () => {
  const next = applyManualReviewField(baseProduct, {
    field: "butlerContact",
    selection: { contactCardId: 1753732, displayName: "张三", providerId: 1279416 },
  });
  const ops = next.operations as Record<string, unknown>;
  const bc = ops.bookingControls as Record<string, unknown>;
  assert.deepEqual(bc.butler, { contactCardId: 1753732, displayName: "张三", providerId: 1279416 });
  // 提前预订字段不被覆盖
  assert.deepEqual(bc.advanceBooking, { days: 1, time: "12:00" });
});

test("管家联系人 selection=null 时清空但保留其它 bookingControls", () => {
  const next = applyManualReviewField(baseProduct, { field: "butlerContact", selection: null });
  const bc = (next.operations as Record<string, unknown>).bookingControls as Record<string, unknown>;
  assert.equal(bc.butler, undefined);
  assert.deepEqual(bc.advanceBooking, { days: 1, time: "12:00" });
});

test("管家联系人 selection 缺少 ID/姓名会被拒绝", () => {
  assert.throws(() => applyManualReviewField(baseProduct, {
    field: "butlerContact",
    selection: { contactCardId: 1, providerId: 1, displayName: "" },
  }), /管家联系人/);
  assert.throws(() => applyManualReviewField(baseProduct, {
    field: "butlerContact",
    selection: { contactCardId: -1, providerId: 1, displayName: "x" },
  }), /管家联系人/);
});

test("用车资源组只写 requestedTotalCost 时其它字段保持不变", () => {
  const next = applyManualReviewField(baseProduct, {
    field: "vehicleResource",
    requestedTotalCost: 380,
  });
  const vr = (next.operations as Record<string, unknown>).vehicleResource as Record<string, unknown>;
  assert.equal(vr.requestedTotalCost, 380);
  assert.equal(vr.resourceGroupId, 88231);
  assert.equal(vr.resourceGroupName, "太原用车组");
});

test("用车资源组 requestedTotalCost=null 表示清空全程预计用车总成本", () => {
  const productWithCost = { ...baseProduct, operations: { ...baseProduct.operations, vehicleResource: { ...baseProduct.operations.vehicleResource, requestedTotalCost: 500 } } };
  const next = applyManualReviewField(productWithCost, { field: "vehicleResource", requestedTotalCost: null });
  const vr = (next.operations as Record<string, unknown>).vehicleResource as Record<string, unknown>;
  assert.equal("requestedTotalCost" in vr, false);
});

test("手动复核不能写入 resourceGroupMaxItemPrice", () => {
  const next = applyManualReviewField(baseProduct, {
    field: "vehicleResource",
    resourceGroupMaxItemPrice: 600,
  } as never);
  const vr = (next.operations as Record<string, unknown>).vehicleResource as Record<string, unknown>;
  assert.equal(vr.resourceGroupMaxItemPrice, undefined);
});

test("全程预计用车总成本必须大于 0 或传 null", () => {
  assert.throws(() => applyManualReviewField(baseProduct, {
    field: "vehicleResource",
    requestedTotalCost: 0,
  }), /全程预计用车总成本/);
});

test("车辆资源组空表也能独立写入 requestedTotalCost", () => {
  const product = {
    ...baseProduct,
    operations: {
      ...baseProduct.operations,
      vehicleResource: undefined,
    },
  };
  const next = applyManualReviewField(product, {
    field: "vehicleResource",
    requestedTotalCost: 420,
  });
  const vr = (next.operations as Record<string, unknown>).vehicleResource as Record<string, unknown>;
  assert.equal(vr.requestedTotalCost, 420);
  assert.equal(vr.resourceGroupId, undefined);
  assert.equal(vr.resourceGroupName, undefined);
});

test("行程 spot 手动 POI 补全只写入目标 spot 并保留其它字段", () => {
  const next = applyManualReviewField(baseProduct, {
    field: "itinerarySpotPoi",
    dayIndex: 0,
    spotIndex: 0,
    poiName: "晋祠博物馆",
    poiId: 79413,
  });
  const days = next.itinerary as Array<{ spots: Array<Record<string, unknown>>; hotel: string }>;
  assert.deepEqual(days[0].spots[0], { name: "晋祠", poiName: "晋祠博物馆", poiId: 79413 });
  assert.deepEqual(days[0].spots[1], { name: "已有景点", poiName: "已有 POI", poiId: 100 });
  assert.deepEqual(days[1].spots[0], { name: "山西博物院", poiName: null, poiId: null });
  assert.equal(days[0].hotel, "太原酒店");
  assert.equal(baseProduct.itinerary[0].spots[0].poiName, null);
});

test("行程 spot 手动 POI 补全拒绝非法 index", () => {
  assert.throws(() => applyManualReviewField(baseProduct, {
    field: "itinerarySpotPoi",
    dayIndex: 99,
    spotIndex: 0,
    poiName: "晋祠博物馆",
    poiId: 79413,
  }), /目标行程天数/);
  assert.throws(() => applyManualReviewField(baseProduct, {
    field: "itinerarySpotPoi",
    dayIndex: 0,
    spotIndex: 99,
    poiName: "晋祠博物馆",
    poiId: 79413,
  }), /目标景点/);
});

test("行程 spot 手动 POI 补全拒绝非法 poiId 或空名称", () => {
  assert.throws(() => applyManualReviewField(baseProduct, {
    field: "itinerarySpotPoi",
    dayIndex: 0,
    spotIndex: 0,
    poiName: "晋祠博物馆",
    poiId: 0,
  }), /POI ID/);
  assert.throws(() => applyManualReviewField(baseProduct, {
    field: "itinerarySpotPoi",
    dayIndex: 0,
    spotIndex: 0,
    poiName: " ",
    poiId: 79413,
  }), /POI 名称/);
});

test("applyManualReviewField 不修改原 product", () => {
  const original = JSON.stringify(baseProduct);
  applyManualReviewField(baseProduct, { field: "pricing", adult: 9999, child: 8888, minimumTravelers: 4 });
  applyManualReviewField(baseProduct, { field: "basicInfoSubtitle", subtitle: "新副标题新副标题" });
  assert.equal(JSON.stringify(baseProduct), original);
});

test("清空 requestedTotalCost 时写入 sentinel 字段，区分「从未设置」与「被主动清除」", () => {
  const next = applyManualReviewField(baseProduct, { field: "vehicleResource", requestedTotalCost: null });
  const vr = (next.operations as Record<string, unknown>).vehicleResource as Record<string, unknown>;
  assert.equal("requestedTotalCost" in vr, false);
  // sentinel 是与 requestedTotalCost 同级的轻量标记，让下游 targetVehicleTotalCost
  // 能区分两种意图。
  assert.equal(vr.requestedTotalCostCleared, true);
});

test("重新填 requestedTotalCost 会撤销清除 sentinel", () => {
  const cleared = applyManualReviewField(baseProduct, { field: "vehicleResource", requestedTotalCost: null });
  const next = applyManualReviewField(cleared, { field: "vehicleResource", requestedTotalCost: 620 });
  const vr = (next.operations as Record<string, unknown>).vehicleResource as Record<string, unknown>;
  assert.equal(vr.requestedTotalCost, 620);
  assert.equal("requestedTotalCostCleared" in vr, false);
});

test("productCover (ctripLibrary) 写入 presentation.cover 并保留其它字段", () => {
  const next = applyManualReviewField(baseProduct, {
    field: "productCover",
    cover: {
      source: "ctripLibrary",
      imageId: 9001,
      imageUrl: "https://example.com/yungang/9001.jpg",
      thumbnailUrl: "https://example.com/yungang/9001-thumb.jpg",
      previewUrl: "https://example.com/yungang/9001-preview.jpg",
      score: 4.6,
      resolution: "1280*1917",
      poiId: 79413,
      poiName: "云冈石窟",
      selectedAt: "2026-01-01T00:00:00.000Z",
      poi: "云冈石窟",
      description: "横版云冈石窟外景",
      minQuality: 3,
    },
  });
  const presentation = next.presentation as Record<string, unknown>;
  assert.deepEqual(presentation.cover, {
    source: "ctripLibrary",
    imageId: 9001,
    imageUrl: "https://example.com/yungang/9001.jpg",
    thumbnailUrl: "https://example.com/yungang/9001-thumb.jpg",
    previewUrl: "https://example.com/yungang/9001-preview.jpg",
    score: 4.6,
    resolution: "1280*1917",
    poiId: 79413,
    poiName: "云冈石窟",
    selectedAt: "2026-01-01T00:00:00.000Z",
    poi: "云冈石窟",
    description: "横版云冈石窟外景",
    minQuality: 3,
  });
  // 保留 presentation 其它字段（recommendation / features 已在 baseProduct）
  assert.equal(presentation.recommendation, "云冈石窟外景横版是产品首图首选。");
  assert.deepEqual(presentation.features, ["一日游", "私家团"]);
  // 保留其它顶层字段
  assert.equal((next.basicInfo as Record<string, unknown>).subtitle, "太原经典私家团");
  assert.equal((next.itinerary as unknown[]).length, 2);
});

test("productCover (ctripLibrary) 仅保留合法可选字段，非法可选字段被剥离", () => {
  const next = applyManualReviewField(baseProduct, {
    field: "productCover",
    cover: {
      source: "ctripLibrary",
      imageId: 9002,
      imageUrl: "https://example.com/yungang/9002.jpg",
      thumbnailUrl: "",
      previewUrl: "  ",
      score: Number.NaN,
      resolution: "",
      poiId: -1,
      poiName: "   ",
      selectedAt: "",
      poi: "云冈石窟",
      description: "横版云冈石窟外景",
      minQuality: 3,
    },
  });
  const cover = (next.presentation as Record<string, unknown>).cover as Record<string, unknown>;
  assert.equal(cover.imageId, 9002);
  assert.equal(cover.imageUrl, "https://example.com/yungang/9002.jpg");
  // 空串 / 非正数 / NaN / 全空白 都不得写入 product JSON。
  assert.equal("thumbnailUrl" in cover, false);
  assert.equal("previewUrl" in cover, false);
  assert.equal("score" in cover, false);
  assert.equal("resolution" in cover, false);
  assert.equal("poiId" in cover, false);
  assert.equal("poiName" in cover, false);
  assert.equal("selectedAt" in cover, false);
});

test("productCover (ctripLibrary) 拒绝缺 imageId / imageUrl", () => {
  // 缺 imageId
  assert.throws(() => applyManualReviewField(baseProduct, {
    field: "productCover",
    cover: {
      source: "ctripLibrary",
      imageUrl: "https://example.com/yungang/no-id.jpg",
      poi: "云冈石窟",
      description: "横版",
      minQuality: 3,
    } as never,
  }), /imageId/);
  // imageId 不是正整数
  assert.throws(() => applyManualReviewField(baseProduct, {
    field: "productCover",
    cover: {
      source: "ctripLibrary",
      imageId: 0,
      imageUrl: "https://example.com/yungang/zero.jpg",
      poi: "云冈石窟",
      description: "横版",
      minQuality: 3,
    } as never,
  }), /imageId/);
  assert.throws(() => applyManualReviewField(baseProduct, {
    field: "productCover",
    cover: {
      source: "ctripLibrary",
      imageId: 1.5,
      imageUrl: "https://example.com/yungang/fractional.jpg",
      poi: "云冈石窟",
      description: "横版",
      minQuality: 3,
    } as never,
  }), /imageId/);
  // 缺 imageUrl
  assert.throws(() => applyManualReviewField(baseProduct, {
    field: "productCover",
    cover: {
      source: "ctripLibrary",
      imageId: 9003,
      poi: "云冈石窟",
      description: "横版",
      minQuality: 3,
    } as never,
  }), /imageUrl/);
  // imageUrl 是空白字符串
  assert.throws(() => applyManualReviewField(baseProduct, {
    field: "productCover",
    cover: {
      source: "ctripLibrary",
      imageId: 9004,
      imageUrl: "   ",
      poi: "云冈石窟",
      description: "横版",
      minQuality: 3,
    } as never,
  }), /imageUrl/);
  // 拒绝语义必须是中文错误，避免运营看到英文堆栈。
  try {
    applyManualReviewField(baseProduct, {
      field: "productCover",
      cover: {
        source: "ctripLibrary",
        imageUrl: "https://example.com/yungang/no-id.jpg",
        poi: "云冈石窟",
        description: "横版",
        minQuality: 3,
      } as never,
    });
    assert.fail("缺 imageId 必须抛错");
  } catch (error) {
    assert.match((error as Error).message, /imageId/);
    assert.match((error as Error).message, /正整数/);
  }
});

test("productCover (manualUpload) 写入完整 meta 并校验 mime / size", () => {
  const next = applyManualReviewField(baseProduct, {
    field: "productCover",
    cover: {
      source: "manualUpload",
      fileId: "11111111-1111-1111-1111-111111111111",
      originalName: "demo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 12345,
      poi: "云冈石窟",
      description: "横版云冈石窟外景",
      minQuality: 3,
      uploadedAt: "2026-01-01T00:00:00.000Z",
    },
  });
  const cover = ((next.presentation as Record<string, unknown>).cover) as Record<string, unknown>;
  assert.equal(cover.source, "manualUpload");
  assert.equal(cover.fileId, "11111111-1111-1111-1111-111111111111");
  assert.equal(cover.sizeBytes, 12345);
});

test("productCover 拒绝非法 mime / size / 空 POI / 缺 fileId", () => {
  assert.throws(() => applyManualReviewField(baseProduct, {
    field: "productCover",
    cover: {
      source: "manualUpload",
      fileId: "id",
      originalName: "demo.gif",
      mimeType: "image/gif",
      sizeBytes: 1024,
      poi: "x",
      description: "y",
      minQuality: 3,
      uploadedAt: "2026-01-01T00:00:00.000Z",
    },
  }), /mime/);
  assert.throws(() => applyManualReviewField(baseProduct, {
    field: "productCover",
    cover: {
      source: "manualUpload",
      fileId: "id",
      originalName: "demo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 0,
      poi: "x",
      description: "y",
      minQuality: 3,
      uploadedAt: "2026-01-01T00:00:00.000Z",
    },
  }), /sizeBytes/);
  assert.throws(() => applyManualReviewField(baseProduct, {
    field: "productCover",
    cover: {
      source: "ctripLibrary",
      imageId: 9005,
      imageUrl: "https://example.com/yungang/empty-poi.jpg",
      poi: "",
      description: "y",
      minQuality: 3,
    },
  }), /POI/);
  assert.throws(() => applyManualReviewField(baseProduct, {
    field: "productCover",
    cover: {
      source: "manualUpload",
      fileId: "",
      originalName: "demo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1024,
      poi: "x",
      description: "y",
      minQuality: 3,
      uploadedAt: "2026-01-01T00:00:00.000Z",
    },
  }), /fileId/);
});

test("productCover 拒绝非法 minQuality（> 5 或 < 0）", () => {
  assert.throws(() => applyManualReviewField(baseProduct, {
    field: "productCover",
    cover: {
      source: "ctripLibrary",
      imageId: 9006,
      imageUrl: "https://example.com/yungang/quality-high.jpg",
      poi: "x",
      description: "y",
      minQuality: 6,
    },
  }), /质量分/);
  assert.throws(() => applyManualReviewField(baseProduct, {
    field: "productCover",
    cover: {
      source: "ctripLibrary",
      imageId: 9007,
      imageUrl: "https://example.com/yungang/quality-low.jpg",
      poi: "x",
      description: "y",
      minQuality: -1,
    },
  }), /质量分/);
});

test("productCover 不会写半成品：旧 presentation.cover 不会因失败而被吞掉", () => {
  const productWithCover = applyManualReviewField(baseProduct, {
    field: "productCover",
    cover: {
      source: "ctripLibrary",
      imageId: 9008,
      imageUrl: "https://example.com/yungang/9008.jpg",
      poi: "云冈石窟",
      description: "横版",
      minQuality: 3,
    },
  });
  // 之后的非法写入抛错，原 cover 应保留
  assert.throws(() => applyManualReviewField(productWithCover, {
    field: "productCover",
    cover: {
      source: "ctripLibrary",
      imageId: 9009,
      imageUrl: "https://example.com/yungang/empty-poi.jpg",
      poi: "",
      description: "y",
      minQuality: 3,
    },
  }), /POI/);
  const cover = ((productWithCover.presentation as Record<string, unknown>).cover) as Record<string, unknown>;
  assert.equal(cover.poi, "云冈石窟");
  assert.equal(cover.imageId, 9008);
});

test("productCover 写入后 productSchema.safeParse 必须成功，且不伪造 recommendation / features", () => {
  // baseProduct 自带 presentation（其中 features 是数组，不符合 schema 对 features 的字符串契约），
  // 这里克隆 baseProduct 后删除 presentation，确保其它顶层字段满足 schema 的最小可解析形态。
  const productWithoutPresentation = structuredClone(baseProduct) as Record<string, unknown>;
  delete productWithoutPresentation.presentation;

  const next = applyManualReviewField(productWithoutPresentation, {
    field: "productCover",
    cover: {
      source: "ctripLibrary",
      imageId: 9010,
      imageUrl: "https://example.com/yungang/9010.jpg",
      poi: "云冈石窟",
      description: "横版云冈石窟外景",
      minQuality: 3,
    },
  });

  const parsed = productSchema.safeParse(next);
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  if (!parsed.success) return;

  const presentation = parsed.data.presentation as Record<string, unknown> | undefined;
  assert.ok(presentation, "presentation 应被自动创建");
  const cover = presentation.cover as Record<string, unknown>;
  assert.equal(cover.source, "ctripLibrary");
  assert.equal(cover.imageId, 9010);
  assert.equal(cover.imageUrl, "https://example.com/yungang/9010.jpg");
  assert.equal(cover.poi, "云冈石窟");
  assert.equal(cover.description, "横版云冈石窟外景");
  assert.equal(cover.minQuality, 3);

  // 关键约束：仅写入 cover 时，绝不能把 recommendation / features 凭空补成空字符串之类。
  assert.equal("recommendation" in presentation, false, "不应伪造 presentation.recommendation");
  assert.equal("features" in presentation, false, "不应伪造 presentation.features");
});
