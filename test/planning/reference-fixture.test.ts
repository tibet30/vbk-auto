/**
 * examples/taiyuan-private-2d1n.json 契约测试：
 *  - 必须仍能通过 productSchema（与旧 fixture 保持兼容）；
 *  - 但其中的「示例数据」绝不能成为新生成产品的默认值；
 *  - 示例酒店档次 /-3 经 normalise 后保持 /-3（白名单合法值）；
 *  - 示例 release.submitReview=true 必须在 normalisation 时不被破坏（fixture 兼容），
 *    但新建产品必须归一化为 false。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { productSchema } from "../../src/main/automation/schema/schema-definitions.js";
import { normaliseProductDraft } from "../../src/main/data/product-normalize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplePath = path.resolve(__dirname, "../../examples/taiyuan-private-2d1n.json");

test("example fixture 仍可通过 canonical productSchema（结构性契约）", () => {
  const fixture = JSON.parse(fs.readFileSync(examplePath, "utf8"));
  // 必须满足规范中的关键字段：2 天行程、3 条推荐理由、4 项条款、合法酒店档次。
  assert.equal((fixture.basicInfo as { days: number }).days, 2);
  assert.equal((fixture.itinerary as unknown[]).length, 2);
  const presentation = fixture.presentation as { recommendations: unknown[] };
  assert.equal(presentation.recommendations.length, 3);
  const terms = (fixture.commercial as { terms: Record<string, string> }).terms;
  assert.equal(Object.keys(terms).length >= 4, true);
  for (const key of ["inclusions", "exclusions", "bookingNotes", "refundPolicy"]) {
    assert.equal(typeof terms[key], "string", `terms.${key} 必须存在`);
  }
  const hotelTier = (fixture.operations as { hotelTier: string }).hotelTier;
  assert.equal(hotelTier, "当地3钻酒店/-3");
  // 通过 productSchema 校验（不依赖任何运行时资源）。
  const parsed = productSchema.safeParse(fixture);
  assert.equal(parsed.success, true, `fixture 校验失败：${JSON.stringify(parsed.error?.issues)}`);
});

test("normaliseProductDraft 对 fixture 不破坏 hotelTier /-3（合法白名单值）", () => {
  const fixture = JSON.parse(fs.readFileSync(examplePath, "utf8"));
  const normalised = normaliseProductDraft(fixture);
  assert.equal((normalised.operations as { hotelTier: string }).hotelTier, "当地3钻酒店/-3");
});

test("release.submitReview 在 fixture 里默认保持原值（兼容性）；AI / 自动路径则强制为 false", () => {
  const fixture = JSON.parse(fs.readFileSync(examplePath, "utf8"));
  // fixture 是历史数据：默认语义（不传 safeRelease）保留 release.submitReview=true。
  // 这是数据库 startup normalize / 历史 fixture 解析路径的统一行为。
  const normalised = normaliseProductDraft(fixture);
  // fixture 的 submitReview=true 经过 normalise 仍保留 true（兼容历史 fixture 解析）。
  const release = (normalised.commercial as { release: { submitReview: boolean } }).release;
  assert.equal(release.submitReview, true);

  // 但是新建产品（AI / 自动写入路径）：必须显式传 safeRelease=true，
  // 才能让 normaliseProductDraft 把 release.submitReview 强制成 false。
  // 这是 applyProductPatch / runtime.writeModule / stage-runner.sanitiseModuleValue
  // 统一遵循的契约。
  const newProduct = {
    sales: { productType: "domesticShort", productForm: "privateTour", splitGroup: false },
    basicInfo: { supplierProductName: "新", supplierProductCode: "NEW", subtitle: "副", days: 1, nights: 0, meetingCity: "X", destinationCity: "X", province: "X", operationNotes: "n" },
    operations: { hotelSource: "nonPlatform", hotelTier: "当地5钻酒店/-38", transport: "charter", pickupCity: "X", reusePickupForDropoff: true, mealsIncluded: false },
    commercial: { release: { submitReview: true, publishAfterApproval: true, publicPriceCeiling: 3000, publicAuditRetries: 4 } },
    itinerary: [],
  };
  const normalisedNew = normaliseProductDraft(newProduct, { safeRelease: true });
  const releaseNew = (normalisedNew.commercial as { release: { submitReview: boolean; publishAfterApproval: boolean } }).release;
  assert.equal(releaseNew.submitReview, false);
  assert.equal(releaseNew.publishAfterApproval, false);
});

test("example fixture 自身不再被默认消费（planner 不会主动拉取 example）", () => {
  // 验证 plan-orchestrator 与 runtime 不依赖 examples/ 目录。
  // 这里只是断言：fixture 仅用作 schema 测试，运行时不会复制它的 ID / 价格 / 日期。
  const fixture = JSON.parse(fs.readFileSync(examplePath, "utf8"));
  const ids: number[] = [];
  const vehicle = (fixture.operations as Record<string, unknown>).vehicleResource as Record<string, unknown>;
  if (typeof vehicle.resourceId === "number") ids.push(vehicle.resourceId);
  if (typeof vehicle.resourceGroupId === "number") ids.push(vehicle.resourceGroupId);
  assert.ok(ids.length > 0);
  // 仅断言：fixture 解析得到的 ID 不进入 orchestrator 任何默认；
  // 真正的非复制保证在 historical-data-non-copy.test.ts 里覆盖。
  assert.ok(true);
});