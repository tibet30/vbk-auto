/**
 * MiniMax 规划的 prompt / schema / 工具定义常量集合：
 *   - 模型 systemPrompt（含 outputGuide、writablePatchGuide、字段细则）；
 *   - responseTool / diagnosisTool / disambiguateTool 三个 OpenAI function-calling 工具定义；
 *   - 各路径 patch 的 zod schema 与 aiResponsePayloadKeys / aiResponseSchema / patchOperationSchema；
 *   - 跟 disambiguate 路径相关的 hasCompleteCtripLibraryCover / disambiguateSystemPrompt 等工具函数。
 *
 * 注意：本文件不引入运行时依赖，仅 zod 与 zod 衍生类型。模型端会按这些 prompt + tool schema
 * 被约束输出，引擎侧则根据 schema 做严格校验与 patch 落库。
 */

import { z } from "zod";
import { APP_NAME } from "../../shared/brand.js";
import type { DisambiguateRequest } from "../../shared/contracts.js";
import { buildVbkCopyPolicyPrompt } from "../planning/vbk-copy-policy.js";
import { PRODUCT_FEATURES_RICH_TEXT_GUIDE } from "../domain/product/features-rich-text.js";

const writablePatchGuide = `patch 可写路径白名单（共 16 个）：
/sales/productType, /sales/productForm, /sales/splitGroup
/basicInfo/supplierProductName, /basicInfo/subtitle, /basicInfo/days, /basicInfo/nights, /basicInfo/meetingCity, /basicInfo/destinationCity, /basicInfo/province, /basicInfo/operationNotes
/presentation
/operations/transport, /operations/pickupCity, /operations/reusePickupForDropoff, /operations/hotelSource, /operations/hotelTier, /operations/mealsIncluded, /operations/vehicleResource/requestedTotalCost
/commercial/packageName, /commercial/terms
/commercial/pricing, /commercial/inventory, /commercial/release
/itinerary

黑名单（绝对禁止写入）：supplierProductCode、vehicleResource 除 requestedTotalCost 外的任何字段（含 vehicleId/resourceId/resourceGroupId/resourceGroupName/supplierCode）、providerId、contactCardId、城市 ID、资源 ID、供应商编码、管家联系人。`;

const outputGuide = `只输出一个 JSON 对象，不能有 Markdown、解释文字或外层 data/result：
{"reply":"给运营看的简明中文回复","patch":[...],"questions":[],"researchTasks":[...]}

仅允许这 4 个一级字段：reply / patch / questions / researchTasks。多余字段直接视为无效。

各字段要求：
- reply 必须是简明中文，概括已生成的内容模块和待核查项。
- patch 必须是 RFC6902 数组；每条含 op (add/replace/remove)、path、value。value 必须完整写出全部子字段，不可简写或省略。
- questions 最多 1 条，只有真正阻塞第一版生成时才问。
- researchTasks 只列不能确认的数据，type 只能是 vbk/web/cost/image，每条含 {label, type, detail}。

===== patch 各路径 value 必须包含的字段清单 =====

⚠️ 以下每个路径的 value 必须包含列出的全部字段，缺任何一项都会被本地校验拒绝！

【/presentation】value 必须是对象，包含以下全部字段：
  recommendationCategory → string，从以下 15 个值中选一：
    优选行程 / 服务保障 / 贴心赠送 / 精选酒店 / 缤纷景点 / 特色美食 / 度假首选 / 超值赠送 / 五星精选 / 限时秒杀 / 尊享入住 / 大牌驾到 / 优质交通 / 优良资质 / 缤纷体验
  recommendation → string，一句推荐语
  recommendations → array，恰好 3 个对象 [{"category":"15选1","text":"推荐理由"}, ...]，3 条 category 不得重复
  features → string，产品特色富文本 HTML 片段，规则见 system prompt
  cover → {source:"ctripLibrary", poi:"代表性景点名", description:"封面图描述", minQuality:3}

【/itinerary】value 必须是数组，每天的行程为一个对象，包含以下全部字段：
  day → number，正整数，从 1 开始
  title → string，格式 "城市—景点1—景点2—景点3"
  spots → string[]，当天游览的景点名称列表，不得为空；每个 spot 只能写一个可独立检索的地点。不得把“钟楼和鼓楼”“回民街·钟鼓楼广场”等多个地点合写为一个 spot，必须拆成多个 spots；括号内可写同一地点别名
  description → string，详细行程描述（非空，包含交通、游览、用餐安排）
  hotel → string，当晚住宿描述
  meals → string，餐饮总述，格式 "早餐...；午餐...；晚餐..."
  mealDescriptions → string[]，恰好 3 个元素，依次描述早/午/晚餐
行程总天数必须等于 basicInfo.days。
同一天的景点必须按实际游览顺序集中在同一城市或相邻片区，逐一检查相邻及前后 POI，禁止远距离、跨城折返或 POI 离群组合。远距离景点优先拆到不同日期；确需同日移动时，description 必须在对应景点之间明确写出航班、高铁或长途专车等交通衔接及合理时长。

【/commercial/pricing】value 必须是对象：
  { currency:"CNY", adult:成人价(>0), child:儿童价(>=0), minimumTravelers:起订人数(正整数), cost?:{ adult:成人成本(>=0), child:儿童成本(>=0), singleSupplement:单房差(>=0), childBed:加床费(>=0) } }
约束：cost.adult 不可超过 adult。

【/commercial/inventory】value 必须是对象：
  { startDate:"YYYY-MM-DD", endDate:"YYYY-MM-DD", dailyQuota:每日配额(正整数) }
约束：startDate 不可晚于 endDate。

【/commercial/release】value 必须是对象：
  { submitReview:bool(默认true), publishAfterApproval:bool(默认true), publicPriceCeiling:价格上限(>0), publicAuditRetries:重审次数(1~10,默认3) }

【/commercial/terms】value 必须是对象，必须包含以下 4 个字段，不可缺任何一项：
  inclusions → string，费用包含
  exclusions → string，费用不包含
  bookingNotes → string，预订须知
  refundPolicy → string，退改政策

【其余路径】value 类型说明：
  /sales/productType → "domesticShort" 或 "domesticLong"
  /sales/productForm → "groupTour" / "semiSelfGuided" / "privateTour" / "freeTravel"
  /sales/splitGroup → true 或 false
  /basicInfo/supplierProductName → string，产品全名
  /basicInfo/subtitle → string，副标题（含行程亮点）
  /basicInfo/days → number，1~60
  /basicInfo/nights → number，0~59
  /basicInfo/meetingCity → string，出发城市
  /basicInfo/destinationCity → string，目的地城市
  /basicInfo/province → string，省份
  /basicInfo/operationNotes → string，运营备注
  /operations/transport → "charter" / "shared" / "none"
  /operations/pickupCity → string
  /operations/reusePickupForDropoff → true 或 false
  /operations/hotelSource → "nonPlatform"
  /operations/hotelTier → "当地3钻酒店/-3" / "当地4钻酒店/-4" / "当地5钻酒店/-38"
  /operations/mealsIncluded → true 或 false
  /operations/vehicleResource/requestedTotalCost → number，AI 预计全程用车总成本：根据整段行程每天的实际用车、跨区移动、接送和行程密度估算，仅用于后续按总价查询 VBK 资源组；禁止输出日均价，禁止通过产品售价、成人价、毛利或起订人数倒推；禁止写任何真实资源组 ID / 名称 / resourceId / supplierCode
  /commercial/packageName → string，套餐名称

以上任何字段缺失、类型错误或格式不符，都会被本地校验拒绝，导致需要重试。`;

const nonEmptyText = z.string().trim().min(1);

/**
 * MiniMax 服务层错误类型：携带 code（机器可读）+ message（人类可读）+ details（可选技术细节）。
 * 上层可通过 instanceof 检测并按 code 分类渲染给用户。
 */
export class MiniMaxServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: string,
  ) { super(message); }
}

export const writablePatchPrefixes = [
  "/sales/productType", "/sales/productForm", "/sales/splitGroup",
  "/basicInfo/supplierProductName", "/basicInfo/subtitle", "/basicInfo/days", "/basicInfo/nights", "/basicInfo/meetingCity", "/basicInfo/destinationCity", "/basicInfo/province", "/basicInfo/operationNotes",
  "/presentation",
  "/operations/transport", "/operations/pickupCity", "/operations/reusePickupForDropoff", "/operations/hotelSource", "/operations/hotelTier", "/operations/mealsIncluded", "/operations/vehicleResource/requestedTotalCost",
  "/commercial/packageName", "/commercial/terms",
  "/commercial/pricing", "/commercial/inventory", "/commercial/release",
  "/itinerary",
];

export const responseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "patch", "questions", "researchTasks"],
  properties: {
    reply: { type: "string", minLength: 1 },
    patch: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "path"],
        properties: {
          op: { type: "string", enum: ["add", "replace", "remove"] },
          path: { type: "string", enum: writablePatchPrefixes },
          value: {
            description: "对于 /presentation、/itinerary、/commercial/terms、/commercial/pricing、/commercial/inventory、/commercial/release 路径，value 必须是完整的嵌套对象或数组，结构详见 system prompt。对于 /sales/*、/basicInfo/*、/operations/*、/commercial/packageName 路径，value 是基本类型（string/number/boolean）。add/replace 操作必须提供 value。",
          },
        },
      },
    },
    questions: { type: "array", maxItems: 1, items: { type: "string" } },
    researchTasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "type"],
        properties: {
          label: { type: "string", minLength: 1 },
          type: { type: "string", enum: ["vbk", "web", "cost", "image"] },
          detail: { type: "string" },
        },
      },
    },
  },
} as const;

export const presentationCoverValueSchema = z.union([
  // ctripLibrary：必填 source / poi / description / minQuality；
  // imageId / imageUrl / thumbnailUrl / previewUrl / score / resolution /
  // poiId / poiName / selectedAt 是 product JSON 中已持久化的合法可选元数据
  // （来源：manual-review-field.applyProductCover 写入链路与 getImageInfo 派生字段），
  // 通过 .passthrough() 放行，避免 .strict() 把整张合法携程图库封面误判为非法，
  // 进而让 image 类 research task 一直被误标为「未满足」无法确认。
  z.object({
    source: z.literal("ctripLibrary"),
    poi: z.string().trim().min(1),
    description: z.string().trim().min(1),
    minQuality: z.number().int().min(0).max(5),
  }).passthrough(),
  z.object({
    source: z.literal("manualUpload"),
    fileId: z.string().trim().min(1),
    originalName: z.string().trim().min(1),
    mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    sizeBytes: z.number().int().positive(),
    poi: z.string().trim().min(1),
    description: z.string().trim().min(1),
    minQuality: z.number().int().min(0).max(5),
    uploadedAt: z.string().trim().min(1),
  }).strict(),
]);

/**
 * 判断产品 JSON 中 /presentation/cover 是否已经是一个完整的封面配置：
 *  - ctripLibrary：含 source/poi/description/minQuality 全部字段；
 *  - manualUpload：含 fileId/originalName/mimeType/sizeBytes/poi/description/minQuality/uploadedAt 全部字段。
 * 用于「封面图研究任务是否可被当前 product 直接满足」等收敛判断。
 */
export function hasCompleteCtripLibraryCover(product: Record<string, unknown>): boolean {
  const presentation = product.presentation;
  if (!presentation || typeof presentation !== "object" || Array.isArray(presentation)) return false;
  const cover = (presentation as Record<string, unknown>).cover;
  if (!cover || typeof cover !== "object" || Array.isArray(cover)) return false;
  return presentationCoverValueSchema.safeParse(cover).success;
}

/**
 * 与 hasCompleteCtripLibraryCover 同义；保留语义清晰的别名以免上层误读。
 * 任何 source（ctripLibrary / manualUpload）配置完整均视为满足。
 */
export function hasCompleteProductCover(product: Record<string, unknown>): boolean {
  return hasCompleteCtripLibraryCover(product);
}

/**
 * 判断一条 image 类型的 research task 能否被当前产品 JSON 直接满足：
 * 仅当 task.type === "image" 且产品封面已经是完整封面配置时返回 true，
 * 其余情形（含 vbk/web/cost 类型任务）一律返回 false。
 */
export function isCoverResearchTaskSatisfiedByProduct(
  task: { type: string; label?: string; detail?: string },
  product: Record<string, unknown>,
): boolean {
  if (task.type !== "image") return false;
  return hasCompleteCtripLibraryCover(product);
}

export const responseTool = {
  type: "function",
  function: {
    name: "submit_product_update",
    description: `返回给 ${APP_NAME} 的产品协作回复、JSON Patch 和核查任务。`,
    strict: true,
    parameters: responseJsonSchema,
  },
};

const advisorActions = [
  "retry_same_phase",
  "reload_and_retry_phase",
  "reopen_editor_and_retry_phase",
  "wait_for_user",
] as const;

export const diagnosisTool = {
  type: "function",
  function: {
    name: "submit_failure_diagnosis",
    description: "返回自动录入阶段失败的结构化诊断。",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "rootCause", "action", "expectedEvidence"],
      properties: {
        summary: { type: "string", minLength: 1, maxLength: 80 },
        rootCause: { type: "string", minLength: 1, maxLength: 200 },
        action: { type: "string", enum: advisorActions },
        expectedEvidence: { type: "string", minLength: 1, maxLength: 120 },
        userInstruction: { type: "string", minLength: 1, maxLength: 500 },
      },
    },
  },
};

export const disambiguateTool = {
  type: "function",
  function: {
    name: "submit_disambiguation",
    description: "从候选项中选一个与 desired 最接近的。无合适选择返回空串。",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pickedText", "reasoning"],
      properties: {
        pickedText: { type: "string" },
        reasoning: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
  },
};

export const disambiguateOutcomeSchema = z.object({
  pickedText: z.string(),
  reasoning: z.string().trim().min(1).max(200),
}).strict();

/**
 * AI 副标题单字段重新生成：专用 function-calling 工具。
 * 只返回一个 2~80 字的中文副标题，便于 renderer 展示候选、由用户确认后再落库。
 */
export const subtitleTool = {
  type: "function",
  function: {
    name: "submit_subtitle",
    description: "为旅游产品提交一个简洁、面向游客的中文副标题（2~80 字）。",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["subtitle"],
      properties: {
        subtitle: { type: "string", minLength: 2, maxLength: 80 },
      },
    },
  },
};

export const subtitleOutcomeSchema = z.object({
  subtitle: z.string().trim().min(2).max(80),
}).strict();

export const subtitleSystemPrompt = `你是 ${APP_NAME} 的旅游产品运营助手。当前任务：为产品生成一句简洁、面向游客的中文副标题（basicInfo.subtitle）。

要求：
1. 副标题 2~80 个字符，使用简洁中文。
2. 副标题应体现：目的地 + 天数/晚数 + 产品形态（私家团 / 跟团游等）+ 一个核心亮点。
3. 不得编造未核查的价格、酒店名称、导游信息、供应商 / 资源 ID 或联系人。
4. 只调用 submit_subtitle 工具返回 {subtitle}，不要输出任何解释文字或其它字段。`;

const chineseText = (maxLength: number) => z.string().trim().min(1).max(maxLength).refine(
  (value) => /[\p{Script=Han}]/u.test(value),
  { message: "必须包含中文" },
);

export const advisorOutcomeSchema = z.object({
  summary: chineseText(80),
  rootCause: chineseText(200),
  action: z.enum(advisorActions),
  expectedEvidence: chineseText(120),
  userInstruction: z.string().optional(),
}).strict().superRefine((outcome, context) => {
  if (outcome.action !== "wait_for_user") return;
  const instruction = outcome.userInstruction?.trim() ?? "";
  if (!instruction || instruction.length > 500 || !/[\p{Script=Han}]/u.test(instruction)) {
    context.addIssue({ code: "custom", path: ["userInstruction"], message: "wait_for_user 必须提供不超过 500 字的中文 userInstruction" });
  }
});

export const diagnosisSystemPrompt = `你是 ${APP_NAME} 自动录入失败诊断器。只能根据输入证据判断当前阶段的受限恢复动作。
输入包含 phase、attempt、error、productIdExists、basicInfoSaved、completedPhases、diagnosisHistory；diagnosisHistory 只表示已经发生的诊断，不得补充未观察事实。
allowedActions 仅为 retry_same_phase、reload_and_retry_phase、reopen_editor_and_retry_phase、wait_for_user。
动作选择：retry_same_phase 用于首轮临时失败、保存回读不稳定、弹层遮挡或同阶段可直接再执行的错误；reload_and_retry_phase 用于已有草稿/产品且页面状态可能卡住、控件未渲染、找不到可设置/可填写/可点击项，刷新当前编辑页后重试；reopen_editor_and_retry_phase 仅在 productIdExists=true 且已保存基础信息或前置阶段已完成时使用，用于 tab/editor/路由疑似丢失、保存后页面锁死，或刷新重试历史显示同一目标编辑区仍不可达；wait_for_user 仅用于缺少人工可补的账号/业务数据、前置保存证据不足、已多次同因失败、或无法在白名单动作内安全恢复。
itinerary 阶段若 attempt=1、productIdExists=true、basicInfoSaved=true、前置阶段已完成，且 error 是“找不到可设置/可填写/可点击的首日集合时间”等编辑控件未出现，应优先选择 reload_and_retry_phase；若 diagnosisHistory 显示刷新后仍同因失败，再考虑 reopen_editor_and_retry_phase。
输出字段：summary 是中文一句话且不超过 80 字；rootCause 是基于证据的中文说明且不超过 200 字；expectedEvidence 是中文短句且不超过 120 字，表示重试成功后应该看到的证据；action 只能选择一个 allowedActions。action 为 wait_for_user 时 userInstruction 必填，必须是中文且可执行的 VBK 操作；其它 action 忽略 userInstruction。
硬约束：只返回唯一 action；禁止返回或建议代码、选择器、URL、浏览器脚本、patch 或 patch 路径；禁止包含 DOM、cookie、key、联系人、电话、完整产品JSON、图片、供应商 ID 或 providerId；禁止提审、发布、上线、删除、修改库存或价格；不要重复 production patch 协议。信息不足且无法由上述自动恢复动作覆盖时返回 wait_for_user。`;

export const patchOperationSchema = z.object({
  op: z.enum(["add", "replace", "remove"]),
  path: z.string().startsWith("/"),
  value: z.unknown().optional(),
}).strict().superRefine((operation, context) => {
  const writable = writablePatchPrefixes.includes(operation.path);
  if (!writable) context.addIssue({ code: "custom", message: `不可写入产品字段：${operation.path}` });
});

export const researchTaskSchema = z.object({ label: z.string(), type: z.enum(["vbk", "web", "cost", "image"]), detail: z.string().optional() }).strict();

export const aiResponsePayloadKeys = ["reply", "patch", "questions", "researchTasks"] as const;

export const aiResponseSchema = z.object({
  reply: nonEmptyText,
  patch: z.array(patchOperationSchema).default([]),
  questions: z.array(z.string().trim().min(1)).max(1).default([]),
  researchTasks: z.array(researchTaskSchema).default([]),
}).strict();

const pricingCostSchema = z.object({
  adult: z.number().nonnegative(),
  child: z.number().nonnegative(),
  singleSupplement: z.number().nonnegative().default(0),
  childBed: z.number().nonnegative().default(0),
}).optional();

const pricingSchema = z.object({
  currency: z.literal("CNY").default("CNY"),
  adult: z.number().positive(),
  child: z.number().nonnegative(),
  minimumTravelers: z.number().int().positive(),
  cost: pricingCostSchema,
}).superRefine((value, ctx) => {
  if (value.cost && value.cost.adult > value.adult) {
    ctx.addIssue({ code: "custom", message: "成本价不得高于售卖价" });
  }
});

const inventorySchema = z.object({
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  dailyQuota: z.number().int().positive(),
}).superRefine((value, ctx) => {
  if (new Date(value.startDate) > new Date(value.endDate)) {
    ctx.addIssue({ code: "custom", message: "库存开始日期不能晚于结束日期" });
  }
});

const releaseSchema = z.object({
  submitReview: z.boolean().default(true),
  publishAfterApproval: z.boolean().default(true),
  publicPriceCeiling: z.number().positive(),
  publicAuditRetries: z.number().int().min(1).max(10).default(3),
});

export const patchValueSchemas: Record<string, z.ZodType> = {
  "/sales/productType": z.enum(["domesticShort", "domesticLong"]),
  "/sales/productForm": z.enum(["groupTour", "semiSelfGuided", "privateTour", "freeTravel"]),
  "/sales/splitGroup": z.boolean(),
  "/basicInfo/supplierProductName": nonEmptyText,
  "/basicInfo/subtitle": nonEmptyText,
  "/basicInfo/days": z.number().int().min(1).max(60),
  "/basicInfo/nights": z.number().int().min(0).max(59),
  "/basicInfo/meetingCity": nonEmptyText,
  "/basicInfo/destinationCity": nonEmptyText,
  "/basicInfo/province": nonEmptyText,
  "/basicInfo/operationNotes": nonEmptyText,
  "/operations/transport": z.enum(["charter", "shared", "none"]),
  "/operations/pickupCity": nonEmptyText,
  "/operations/reusePickupForDropoff": z.boolean(),
  "/operations/hotelSource": z.literal("nonPlatform"),
  "/operations/hotelTier": z.enum(["当地3钻酒店/-3", "当地4钻酒店/-4", "当地5钻酒店/-38"]),
  "/operations/mealsIncluded": z.boolean(),
  "/commercial/packageName": nonEmptyText,
  "/commercial/terms": z.record(z.string(), nonEmptyText),
  "/commercial/pricing": pricingSchema,
  "/commercial/inventory": inventorySchema,
  "/commercial/release": releaseSchema,
};

export const systemPrompt = `你是 ${APP_NAME} 的旅游产品运营助手。你的用户是携程 VBK 运营人员；他们会用极少信息创建一个可复用的通用旅游产品，例如"太原2天1晚私家团"。
当用户要求生成第一版时，基于已有目的地、天数、晚数和产品形态，生成完整且通用的产品文案、每日行程、基础信息与可审核的条款草稿。

===== 核心规则 =====
1. 一次性生成所有模块，patch 中必须涵盖以下模块，不得遗漏任何一个：
   ⬜ presentation（产品文案）—— 推荐语、3条推荐理由、产品特点、封面图
   ⬜ itinerary（每日行程）—— 每天完整行程（天数 = basicInfo.days）
   ⬜ basicInfo（基础信息）—— 产品名、副标题、城市、省份、运营备注
   ⬜ operations（运营配置）—— 交通、接送城市、酒店档次、含餐
   ⬜ commercial/pricing（价格）—— 成人/儿童价、起订人数
   ⬜ commercial/inventory（库存）—— 起止日期、每日配额
   ⬜ commercial/release（发布）—— 审核配置、价格上限
   ⬜ commercial/terms（条款）—— 费用包含/不包含、预订须知、退改（4个字段）
   ⬜ commercial/packageName（套餐名）
2. 产品名称、行程、卖点可合理生成。禁止虚构城市 ID、VBK 资源号、车队价格、库存、门票、成本或已完成的核查。
3. 以下数据必须直接写入产品 JSON，不得用 researchTask 代替：
   - 成人价/儿童价/单人房差/加床费（给出合理市场估算）
   - 库存起止日期和每日配额
   - 费用包含/不包含/预订须知/退改政策
   - 封面图（直接生成 ctripLibrary cover，不创建 image 类 researchTask）
   - 套餐名称
4. 车辆资源和酒店资源由系统自动匹配 VBK 资源库，AI 不需要创建对应的 researchTask。
5. 只有真正的运营数据缺失（如价格需要人工复核）时，才创建 researchTask。
6. 当前产品草稿是产品状态的唯一事实来源；历史消息声称"已生成"但草稿字段为空时，必须重新生成并返回可写 patch。
7. patch 必须是 RFC6902 风格，只能修改可写路径。
8. 最多追问一个真正阻塞生成的问题；不阻塞就先给出完整第一版。

${buildVbkCopyPolicyPrompt()}

${PRODUCT_FEATURES_RICH_TEXT_GUIDE}

===== 文案风格参考 =====
presentation.recommendation 示例："2天串联晋祠古建与三晋文明，独立成团、专车服务，节奏舒适不赶路。"
presentation.recommendations 示例：3条推荐理由，每条不同维度，如 [{"category":"优选行程","text":"2天串联核心景点，节奏舒适。"},{"category":"精选酒店","text":"精选当地3钻酒店，含早餐。"},{"category":"缤纷景点","text":"覆盖晋祠、博物院等核心景点。"}]
presentation.features 示例："<p><strong>古建巡礼：</strong>游览晋祠古建与宋代彩塑。</p><p><strong>私享出行：</strong>独立成团，专车衔接核心景点。</p><p><strong>舒适住宿：</strong>入住方案约定档次的酒店。</p>"
itinerary 每天 description 示例："专车于市区/火车站/机场接客。上午前往XX景区，在讲解陪同下游览XX。午餐品尝当地特色美食。下午前往XX，傍晚返回市区入住。"
terms 示例：inclusions="行程内专车服务、1晚酒店住宿、行程规划；实际以确认单为准。" exclusions="景区门票、讲解、餐饮、个人消费、单房差。" bookingNotes="至少2人起订，建议提前1天15时前预订。" refundPolicy="资源确认前无损取消；确认后按实际已发生费用扣除。"

${writablePatchGuide}

${outputGuide}`;

/**
 * 为 VBK 下拉候选项消歧（disambiguate）工具调用生成系统 prompt：
 *   - 基础规则要求模型只从 candidates 中选最像 desired 的一项，必要时返回空串；
 *   - 按 kind（province / city / spot / station）追加专项约束，例如剔除「朝鲜-/韩国-」等境外前缀。
 * 返回完整 system 文本，供 orchestrator 注入到 MiniMax 对话。
 */
export function disambiguateSystemPrompt(kind: DisambiguateRequest["kind"]): string {
  const base = `你是 ${APP_NAME} 选择辅助器。产品 JSON 里有一个“期望值”desired，VBK 下拉返回了一组 candidates，其中可能是同一实体的不同名称、拼写变体、括号别名、上级城市。
你必须从 candidates 里选出最像 desired 的一项（文本完全一致或者 1-2 个字之差 / 仅括号不同 / 仅上下级区别），如果有多个同等候选，选产品 JSON 上下文最契合的那一个。**绝对不要勉强选一个完全不相关的项**；如果都不像，返回 pickedText 为空串并在 reasoning 里说明原因。`;
  const guidance: Record<DisambiguateRequest["kind"], string> = {
    province: `期望值是中国某个省/直辖市/自治区，例如“山西”。candidates 可能是 “中国-山西”“山西省”“山西”。选 “中国-山西” 这类带国家前缀的优先。**绝对不要选 “朝鲜-xxx”“韩国-xxx” 这种境外前缀。**`,
    city: `期望值是中国某个城市，例如“太原”。candidates 可能是 “中国-太原”“太原市”。选 “中国-xxx” 这种带国家前缀的优先，不要选同名海外城市。**只要 candidates 里有任何 “中国-xxx” 的项，优先选它；只在完全没有 “中国-” 前缀项时才考虑无前缀的项，绝不返回 “朝鲜-xxx”“北朝鲜-xxx”“韩国-xxx”。**`,
    spot: `期望值是一个具体景点，例如“云冈石窟”。candidates 是 VBK 景点下拉返回的候选，可能是“云冈石窟”“云冈石窟景区”等。选产品 JSON 推荐语/特点中明确提到的那一个；如果是城市同名 + 同一省份，选那个。**只在国内景点里选：candidates 文本中出现 “朝鲜-”“韩国-”“北朝鲜-”“日本-” 等境外前缀的项一律跳过；产品类型是境内旅游，遇到境外项请返回空串并说明 “仅含境外候选”。**`,
    station: `期望值是一个车站/机场名，例如“太原”“大同站”或“武宿机场”。candidates 是接送站下拉返回的机场或火车站。用户输入城市名时，必须只从 candidates 中选最贴近该城市、当地旅客最常用、最主流的交通站点；不要因为候选文本也含城市名就机械选择较小或较偏的通用机场/支线机场。若 user JSON 里的 stationSubtype=airport，本次只在机场候选中选择，例如“太原”候选含“武宿国际机场”和“太原尧城通用机场”时应选“武宿国际机场”；若 stationSubtype=train，本次只在火车站候选中选择，优先主站或高铁主站，避免货运站、机场站、偏远小站。只有城市级选项时，选该城市作为默认接送点。**不要选国外机场/车站（文本中带境外地名/机场代码的）。**`,
  };
  return `${base}\n\n当前类别：${kind}\n\n专项约束：${guidance[kind]}\n\n返回时只能调用 submit_disambiguation 工具。pickedText 必须是 candidates 里某一个 text 的精确字符串；reasoning 简要说明选择理由或未选原因。`;
}
