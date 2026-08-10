/**
 * 右侧 review 面板「基础信息」模块的纯数据抽取单元测试。
 *
 * 这里只覆盖 renderer 端的 helper：
 *  - readBasicInfoFromProduct：把 product 树上的字段安全读出来（缺失 → null，不抛）；
 *  - parsePricingDraft：UI 草稿 → 主进程可用数值；
 *  - parseRequestedDailyCostDraft：UI 草稿 → 主进程可用数值或清除信号。
 *
 * 写入主路径的合法性由 src/main/operations/manual-review-field.test.ts 覆盖；
 * UI 渲染 / IPC 交互无 DOM 测试基础设施（项目仅使用 tsx --test），
 * 因此 UI 行为以现有 E2E 与手动验收为准。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePricingDraft,
  parseRequestedDailyCostDraft,
  readBasicInfoFromProduct,
  shouldShowVehicleResourceRow,
} from "../../src/renderer/app/views/workspace/review-summary-basic-info.helpers.js";

const baseProduct = {
  sales: { productType: "domesticShort", productForm: "privateTour", splitGroup: false },
  basicInfo: { subtitle: " 太原精品两日私家团 " },
  commercial: { pricing: { currency: "CNY", adult: 1680, child: 980 } },
  operations: {
    bookingControls: {
      butler: { contactCardId: 1753732, displayName: "张三", providerId: 1279416 },
    },
    vehicleResource: {
      resourceGroupId: 88231,
      resourceGroupName: "太原用车组",
      requestedDailyCost: 380,
    },
  },
};

test("readBasicInfoFromProduct 完整产品可读取全部字段", () => {
  const snapshot = readBasicInfoFromProduct(baseProduct);
  assert.equal(snapshot.productForm, "privateTour");
  assert.equal(snapshot.subtitle, "太原精品两日私家团");
  assert.deepEqual(snapshot.butler, { contactCardId: 1753732, displayName: "张三", providerId: 1279416 });
  assert.equal(snapshot.adult, 1680);
  assert.equal(snapshot.child, 980);
  assert.equal(snapshot.currency, "CNY");
  assert.equal(snapshot.vehicleResource.exists, true);
  assert.equal(snapshot.vehicleResource.resourceGroupId, 88231);
  assert.equal(snapshot.vehicleResource.resourceGroupName, "太原用车组");
  assert.equal(snapshot.vehicleResource.requestedDailyCost, 380);
});

test("readBasicInfoFromProduct 缺失子字段时显式返回 null，不抛错", () => {
  const snapshot = readBasicInfoFromProduct({});
  assert.equal(snapshot.subtitle, null);
  assert.equal(snapshot.butler, null);
  assert.equal(snapshot.adult, null);
  assert.equal(snapshot.child, null);
  assert.equal(snapshot.currency, null);
  assert.equal(snapshot.productForm, null);
  assert.equal(snapshot.vehicleResource.exists, false);
  assert.equal(snapshot.vehicleResource.resourceGroupId, null);
  assert.equal(snapshot.vehicleResource.resourceGroupName, null);
  assert.equal(snapshot.vehicleResource.requestedDailyCost, null);
});

test("readBasicInfoFromProduct 防御式拒绝 null / 数组 / 字符串", () => {
  assert.deepEqual(readBasicInfoFromProduct(null), readBasicInfoFromProduct({}));
  assert.deepEqual(readBasicInfoFromProduct([]), readBasicInfoFromProduct({}));
  assert.deepEqual(readBasicInfoFromProduct("oops"), readBasicInfoFromProduct({}));
});

test("readBasicInfoFromProduct 拒绝不完整的 ContactCardSelection", () => {
  const noId = readBasicInfoFromProduct({
    operations: { bookingControls: { butler: { displayName: "x", providerId: 1 } } },
  });
  assert.equal(noId.butler, null);

  const blankName = readBasicInfoFromProduct({
    operations: { bookingControls: { butler: { contactCardId: 1, displayName: "  ", providerId: 1 } } },
  });
  assert.equal(blankName.butler, null);

  const wrongTypes = readBasicInfoFromProduct({
    operations: { bookingControls: { butler: { contactCardId: "1", displayName: 1, providerId: null } } },
  });
  assert.equal(wrongTypes.butler, null);
});

test("readBasicInfoFromProduct requestedDailyCost 可独立为 null，资源组字段仍可读", () => {
  const snapshot = readBasicInfoFromProduct({
    operations: { vehicleResource: { resourceGroupId: 5, resourceGroupName: "5 座经济" } },
  });
  assert.equal(snapshot.vehicleResource.requestedDailyCost, null);
  assert.equal(snapshot.vehicleResource.exists, true);
  assert.equal(snapshot.vehicleResource.resourceGroupId, 5);
  assert.equal(snapshot.vehicleResource.resourceGroupName, "5 座经济");
});

test("shouldShowVehicleResourceRow 私家团空资源组也展示入口", () => {
  const snapshot = readBasicInfoFromProduct({
    sales: { productForm: "privateTour" },
    operations: {},
  });
  assert.equal(shouldShowVehicleResourceRow(snapshot), true);
});

test("shouldShowVehicleResourceRow 跟团游无资源组不展示入口", () => {
  const snapshot = readBasicInfoFromProduct({
    sales: { productForm: "groupTour" },
    operations: {},
  });
  assert.equal(shouldShowVehicleResourceRow(snapshot), false);
});

test("shouldShowVehicleResourceRow 跟团游空 vehicleResource 不展示入口", () => {
  const snapshot = readBasicInfoFromProduct({
    sales: { productForm: "groupTour" },
    operations: { vehicleResource: {} },
  });
  assert.equal(shouldShowVehicleResourceRow(snapshot), false);
});

test("shouldShowVehicleResourceRow 跟团游已有车辆资源数据时展示入口", () => {
  const withCost = readBasicInfoFromProduct({
    sales: { productForm: "groupTour" },
    operations: { vehicleResource: { requestedDailyCost: 380 } },
  });
  assert.equal(shouldShowVehicleResourceRow(withCost), true);

  const withId = readBasicInfoFromProduct({
    sales: { productForm: "groupTour" },
    operations: { vehicleResource: { resourceGroupId: 5 } },
  });
  assert.equal(shouldShowVehicleResourceRow(withId), true);

  const withName = readBasicInfoFromProduct({
    sales: { productForm: "groupTour" },
    operations: { vehicleResource: { resourceGroupName: "5 座经济" } },
  });
  assert.equal(shouldShowVehicleResourceRow(withName), true);
});

test("shouldShowVehicleResourceRow 未知产品形态已有车辆资源数据时展示入口", () => {
  const snapshot = readBasicInfoFromProduct({
    operations: { vehicleResource: { requestedDailyCost: 380 } },
  });
  assert.equal(shouldShowVehicleResourceRow(snapshot), true);
});

test("parsePricingDraft 接受合法正整数 / 0 儿童价", () => {
  assert.deepEqual(parsePricingDraft("1680", "0"), { adult: 1680, child: 0 });
  assert.deepEqual(parsePricingDraft("1680", "980"), { adult: 1680, child: 980 });
  assert.deepEqual(parsePricingDraft("1680.5", "980.5"), { adult: 1680.5, child: 980.5 });
});

test("parsePricingDraft 拒绝 0 / 负数 / NaN / 空串", () => {
  assert.equal(parsePricingDraft("0", "100"), null);
  assert.equal(parsePricingDraft("-1", "100"), null);
  assert.equal(parsePricingDraft("abc", "100"), null);
  assert.equal(parsePricingDraft("", "100"), null);
  assert.equal(parsePricingDraft("1000", "-1"), null);
  assert.equal(parsePricingDraft("1000", "abc"), null);
});

test("parseRequestedDailyCostDraft 接受正数；空串 / 0 / 负数 / 非数 标记为 invalid", () => {
  assert.equal(parseRequestedDailyCostDraft("380"), 380);
  assert.equal(parseRequestedDailyCostDraft("380.5"), 380.5);
  assert.equal(parseRequestedDailyCostDraft(""), "invalid");
  assert.equal(parseRequestedDailyCostDraft("0"), "invalid");
  assert.equal(parseRequestedDailyCostDraft("-1"), "invalid");
  assert.equal(parseRequestedDailyCostDraft("abc"), "invalid");
});

test("parseRequestedDailyCostDraft null 信号必须由调用方显式产生，不在 helper 内", () => {
  // helper 永远不返回 null；清除动作由 UI 用空串触发后单独发送 null 字段给主进程。
  // 这里用作「保证不会把空串误写成 0」的反向断言。
  const parsed = parseRequestedDailyCostDraft("   ");
  assert.equal(parsed, "invalid");
});
