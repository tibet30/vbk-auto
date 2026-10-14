import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { generatedCoverPrompt, generatedCoverSubject, generateThemeCover } from "../../src/main/operations/generated-cover.js";
import { inspectManualCoverAsset } from "../../src/main/automation/manual-cover-asset.js";
import { applyAutoCoverFill } from "../../src/main/operations/cover-auto-fill.js";
import { presentationSchema } from "../../src/main/automation/schema/schema-definitions/presentation.js";
import { readManualCoverDataUrl } from "../../src/main/infrastructure/database/parts/cover-storage.js";

const product = { basicInfo: { supplierProductName: "西安6天5晚私家团", meetingCity: "西安", days: 6, nights: 5 },
  presentation: { recommendation: "秦岭温泉与人文", cover: { source: "ctripLibrary", poi: "张良庙" } },
  itinerary: [{ day: 1, title: "太白山唐镇温泉", spots: [{ name: "太白山唐镇", poiId: 1 }] },
    { day: 3, title: "留坝人文", spots: [{ name: "张良庙", poiId: 79410 }] }] };
const bytes = readFileSync(new URL("../fixtures/product-regression/xian-cover.png", import.meta.url));
const inspect: typeof inspectManualCoverAsset = (value, dataPath) => inspectManualCoverAsset(value, dataPath, () => ({ width: 1600, height: 1000 }));
const dataPath = () => mkdtempSync(path.join(os.tmpdir(), "generated-cover-"));
const response = () => new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { image_base64: [bytes.toString("base64")] } }));

test("主题插画按保存的产品、路线和卖点构造提示词，限制长度", () => {
  const prompt = generatedCoverPrompt(product);
  for (const fact of ["主景点是「张良庙」", "唯一清晰主视觉", "1600×1000", "西安6天5晚私家团", "秦岭温泉与人文", "太白山唐镇", "主题插画"]) assert.ok(prompt.includes(fact));
  assert.ok(prompt.length <= 1500);
  assert.ok(generatedCoverPrompt({ ...product, presentation: { recommendation: "长文".repeat(5000) } }).length <= 1500);
});

test("AI 主景点与图库首选关键词一致，无景点时才退到目的地城市", () => {
  assert.equal(generatedCoverSubject(product), "张良庙");
  assert.equal(generatedCoverSubject({ basicInfo: { meetingCity: "西安" }, itinerary: [] }), "西安");
});

test("Image-01 使用现有密钥、1600×1000 和 base64；副本可回读且来源记录不丢失", async () => {
  const root = dataPath();
  const cover = await generateThemeCover({ product, apiKey: "test-key", baseUrl: "https://api.minimaxi.com/v1", dataPath: root, inspect,
    fetch: async (url, init) => {
      assert.equal(String(url), "https://api.minimaxi.com/v1/image_generation");
      const request = JSON.parse(String(init?.body));
      assert.deepEqual([request.model, request.width, request.height, request.n, request.response_format], ["image-01", 1600, 1000, 1, "base64"]);
      assert.equal(request.aspect_ratio, undefined);
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-key");
      return response();
    } });
  const saved = presentationSchema.parse({ cover });
  assert.equal(saved.cover?.source, "manualUpload");
  assert.equal(saved.cover?.source === "manualUpload" && saved.cover.generation?.model, "image-01");
  assert.equal(saved.cover?.poi, "张良庙");
  assert.match(saved.cover?.description ?? "", /张良庙/);
  const original = await readManualCoverDataUrl({ dataPath: root, fileId: String(cover.fileId), originalName: String(cover.originalName) });
  assert.ok(original.url?.startsWith("data:image/png;base64,"));
});

test("生成失败、空响应、非图片和尺寸不足不会形成可用封面，错误不包含凭据", async () => {
  for (const providerResponse of [
    new Response("denied", { status: 401 }),
    new Response(JSON.stringify({ base_resp: { status_code: 1004, status_msg: "test-secret" } })),
    new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { image_base64: [] } })),
    new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { image_base64: [Buffer.from("bad").toString("base64")] } })),
  ]) {
    await assert.rejects(() => generateThemeCover({ product, apiKey: "test-secret", baseUrl: "https://api.minimaxi.com/v1", dataPath: dataPath(), inspect,
      fetch: async () => providerResponse }), (error: Error) => !error.message.includes("test-secret"));
  }
  await assert.rejects(() => generateThemeCover({ product, apiKey: "key", baseUrl: "https://api.minimaxi.com/v1", dataPath: dataPath(),
    fetch: async () => response(), inspect: () => ({ asset: null, issue: "尺寸不足", reason: "dimensions" }) }), /尺寸不足/);
});

test("图库成功空结果才生成一次并保存；查询故障不得触发 AI 生成", async () => {
  let generations = 0;
  const generateCover = async (value: Record<string, unknown>) => {
    generations++;
    return generateThemeCover({ product: value, apiKey: "key", baseUrl: "https://api.minimaxi.com/v1", dataPath: dataPath(), inspect, fetch: async () => response() });
  };
  const result = await applyAutoCoverFill({ page: {} as never, product, generateCover,
    injectSearch: async (_page, keyword) => ({ keyword, poi: keyword, fetchedAt: "t", candidates: [] }) });
  assert.equal(generations, 1);
  assert.equal(result.outcome.written, true);
  assert.match(result.outcome.reason, /重新审批/);
  assert.equal(presentationSchema.parse(result.nextProduct.presentation).cover?.source, "manualUpload");
  await applyAutoCoverFill({ page: {} as never, product, generateCover,
    injectSearch: async () => { throw new Error("图库暂不可用"); } });
  assert.equal(generations, 1);
});

test("图库有合格候选时不会调用图片生成服务", async () => {
  const result = await applyAutoCoverFill({ page: {} as never, product,
    generateCover: async () => { throw new Error("不应生成"); },
    injectSearch: async (_page, keyword) => ({ keyword, poi: keyword, fetchedAt: "t", candidates: [{ stableId: "1", index: 0,
      imageId: 1, imageUrl: "https://example.test/image.jpg", imageResolved: true, quality: "4", resolution: "1600*1000", poiId: 79410, poiName: "张良庙" }] }) });
  assert.equal((result.nextProduct.presentation as { cover: { source: string } }).cover.source, "ctripLibrary");
});

test("图库只返回不合格候选时也视为未匹配，自动生成一次", async () => {
  let generations = 0;
  const generated = { source: "manualUpload", fileId: "ai", originalName: "ai.png", mimeType: "image/png",
    sizeBytes: 100, uploadedAt: "2026-10-14T00:00:00Z", poi: "张良庙", description: "AI 封面", minQuality: 3 };
  const result = await applyAutoCoverFill({ page: {} as never, product,
    generateCover: async () => { generations += 1; return generated; },
    injectSearch: async (_page, keyword) => ({ keyword, poi: keyword, fetchedAt: "t", candidates: [{ stableId: "small", index: 0,
      imageId: 2, imageUrl: "https://example.test/small.jpg", imageResolved: true, quality: "2", resolution: "800*500", poiId: 79410, poiName: "张良庙" }] }) });
  assert.equal(generations, 1);
  assert.equal(result.outcome.written, true);
  assert.deepEqual((result.nextProduct.presentation as { cover: unknown }).cover, generated);
});
