/** 主进程 IPC 运行时入参边界；TypeScript 类型在 renderer 边界不会保留。 */

import { z } from "zod";
import { PRODUCT_FORMS } from "../../shared/product-form.js";

const localProductIdSchema = z.string().trim().min(1).max(160)
  .regex(/^[A-Za-z0-9._:-]+$/, "产品 ID 含非法字符");
const shortTextSchema = z.string().trim().min(1).max(300);
const automationPhaseSchema = z.enum([
  "basic",
  "presentation",
  "itinerary",
  "package",
  "pricingInventory",
  "terms",
  "hotelResource",
  "vehicleResource",
  "preflight",
  "saleControl",
]);
const planningMajorStageSchema = z.enum(["foundation", "itinerary", "completion"]);

const PRODUCT_ID_FIRST_CHANNELS = new Set([
  "products:get", "products:delete", "products:readiness", "products:updateReviewField", "products:updateProductJson",
  "ai:send", "ai:regenerate",
  "research:accept", "research:refreshIssues", "research:vehicleResource", "research:hotelResource",
  "automation:start", "automation:stop", "automation:retry", "automation:retryPhase", "automation:retryOnePhase",
  "planning:start", "planning:resume", "planning:state", "planning:rerunMajorStage", "planning:acceptItineraryAndRerunCompletion",
]);

function parse<T>(channel: string, label: string, schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`[ipc] invalid arguments: channel=${channel} field=${label}`);
  }
  return result.data;
}

function assertPlainObject(channel: string, label: string, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`[ipc] invalid arguments: channel=${channel} field=${label}`);
  }
}

/** 在业务 handler 执行前校验通道公共边界，不把原始输入写入错误或日志。 */
export function validateIpcArguments(channel: string, args: unknown[]): void {
  if (PRODUCT_ID_FIRST_CHANNELS.has(channel)) {
    parse(channel, "localProductId", localProductIdSchema, args[0]);
  }

  if (channel === "products:create") {
    const input = parse(channel, "input", z.object({
      destination: z.string().trim().min(1).max(100),
      // VBK 的旅游产品基本信息把 0 晚判为必填失败；新建入口只允许可保存的 2 天起产品。
      days: z.number().int().min(2).max(60),
      productForm: z.enum(PRODUCT_FORMS),
      userIdea: z.string().max(1000).optional(),
      autoConfirm: z.boolean().optional(),
    }).strict(), args[0]);
    void input;
  }
  if (channel === "products:updateProductJson") {
    parse(channel, "json", z.string().min(2).max(2_000_000), args[1]);
  }
  if (channel === "ai:send") parse(channel, "content", z.string().trim().min(1).max(6000), args[1]);
  if (channel === "ai:regenerate") parse(channel, "field", shortTextSchema, args[1]);

  if (channel === "automation:retryPhase" || channel === "automation:retryOnePhase") {
    parse(channel, "phase", automationPhaseSchema, args[1]);
  }
  if (channel === "planning:rerunMajorStage") parse(channel, "stage", planningMajorStageSchema, args[1]);
  if (channel === "browser:status" && args[0] !== undefined) parse(channel, "refresh", z.boolean(), args[0]);
  if (channel === "browser:setVisible") parse(channel, "visible", z.boolean(), args[0]);
  if (channel === "browser:setBounds") {
    parse(channel, "bounds", z.object({
      x: z.number().int().min(-10_000).max(20_000),
      y: z.number().int().min(-10_000).max(20_000),
      width: z.number().int().min(0).max(20_000),
      height: z.number().int().min(0).max(20_000),
    }).strict(), args[0]);
  }
  if (channel === "browser:navigate") parse(channel, "url", z.url().max(2048), args[0]);

  if (["poi:suggest", "poi:suggestDetail", "poi:suggestDemo", "contacts:suggestPoi"].includes(channel)) {
    parse(channel, "keyword", z.string().trim().max(200), args[0]);
  }
  if (["browser:switchAccount", "browser:forgetAccount"].includes(channel)) {
    parse(channel, "accountKey", shortTextSchema, args[0]);
  }
  if (["accounts:getFixedInfo", "accounts:saveFixedInfo", "accounts:providerIdFor"].includes(channel)) {
    parse(channel, "accountName", shortTextSchema, args[0]);
  }
  if (channel === "contacts:listProviderContactCards") {
    parse(channel, "providerId", z.number().int().positive(), args[0]);
    if (args[1] !== undefined) parse(channel, "searchKeyword", z.string().max(200), args[1]);
  }

  if (["settings:listModels", "settings:save", "settings:test", "products:updateReviewField"].includes(channel)) {
    assertPlainObject(channel, "input", channel === "products:updateReviewField" ? args[1] : args[0]);
  }
  if (channel === "appAuth:login") {
    parse(channel, "input", z.object({
      phone: z.string().regex(/^1\d{10}$/),
      password: z.string().min(1).max(256),
      captchaId: z.string().trim().min(1).max(128),
      captchaCode: z.string().trim().min(1).max(8),
    }).strict(), args[0]);
  }
  if (channel === "appAuth:switchAccount") {
    parse(channel, "userId", z.number().int().positive(), args[0]);
  }
  if (channel.startsWith("cover:")) {
    if (!new Set(["cover:listManualCovers"]).has(channel)) assertPlainObject(channel, "input", args[0]);
  }
}
