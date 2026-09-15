/**
 * 把 MiniMax / Evolink 的原始模型输出解析成强类型 AiResponse 的全套工具：
 *   - 顶层入口 parseAssistantMessage（处理 tool_calls + content 两种形态）
 *   - parseJson / parseValue / unwrapResponse（结构化解析 + 自动修复）
 *   - stripInlineNoise / normalizeModelPayload / extractTopLevelJsonCandidates 等清洗工具
 *   - repairSingleQuotedJson / completeJsonTail / trimTrailingComma / quoteUnquotedKeys（修复变体）
 *   - parseSparseResponse / parseLooseFieldValue 等「松散字段提取」回退
 *
 * 设计目标：在模型返回的 JSON 不合规时尽量「救回来」（fallback），但**绝不**伪造结构化字段，
 * 救不回来的情况返回 isStructured=false 让上层决定 retry / fail。
 */

import type { AiResponse } from "../../shared/contracts.js";
import { z } from "zod";
import { logWarn } from "../../shared/log-timestamp.js";
import { parseRecoveredJson } from "./minimax-parsing-repair.js";
import {
  MiniMaxServiceError,
  aiResponsePayloadKeys,
  aiResponseSchema,
  patchOperationSchema,
  patchValueSchemas,
  researchTaskSchema,
} from "./minimax-constants.js";

/**
 * 把单个 JSON Patch operation 规整为产品协议期望的形态：
 *   - 先用 pathAlias 把模型常见的变体路径（basic_info/subtitle 等）映射回标准路径；
 *   - 然后用 patchValueSchemas[path] 对 value 做严格解析；
 *   - remove 不需要 value；其它路径若解析失败返回 undefined 让上游丢弃；
 *   - 解析成功则合并 zod 的 parsed.data（缺字段会被剔除）。
 */
export function normalisePatchOperation(operation: z.infer<typeof patchOperationSchema>) {
  if (operation.op === "remove") return operation;
  // 路径变体映射：模型常把 "basic_info/subtitle" 或 "transport_mode" 等非标准路径写出，
  // 统一规整到产品协议里的可写路径。
  const alias = pathAlias(operation.path);
  if (alias !== operation.path) {
    operation = { ...operation, path: alias };
  }
  if (operation.path === "/presentation") {
    operation = { ...operation, value: normalisePresentationValue(operation.value) };
  } else if (operation.path === "/itinerary") {
    operation = { ...operation, value: normaliseItineraryValue(operation.value) };
  }
  const schema = patchValueSchemas[operation.path];
  if (!schema) return operation;
  const parsed = schema.safeParse(operation.value);
  return parsed.success ? { ...operation, value: parsed.data } : undefined;
}

function normalisePresentationValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {
    recommendationCategory: typeof source.recommendationCategory === "string"
      ? source.recommendationCategory
      : "优选行程",
  };
  const recommendation = typeof source.recommendation === "string"
    ? source.recommendation
    : source.description;
  if (typeof recommendation === "string" && recommendation.trim()) {
    result.recommendation = recommendation.trim();
  }
  const features = typeof source.features === "string"
    ? source.features
    : Array.isArray(source.highlights)
      ? source.highlights.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).join("\n")
      : undefined;
  if (typeof features === "string" && features.trim()) result.features = features.trim();
  if (Array.isArray(source.recommendations)) result.recommendations = source.recommendations;
  if (source.cover && typeof source.cover === "object") result.cover = source.cover;
  return result;
}

function normaliseItineraryValue(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const source = entry as Record<string, unknown>;
    const legacyActivities = Array.isArray(source.activities)
      ? source.activities.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      : [];
    const activities = legacyActivities.map((item) => ({
      time: typeof item.time === "string" ? item.time : "",
      title: typeof item.title === "string" ? item.title : typeof item.name === "string" ? item.name : "",
      detail: typeof item.detail === "string" ? item.detail : "",
      type: typeof item.type === "string" ? item.type : "other",
    }));
    const spots = Array.isArray(source.spots)
      ? source.spots
      : activities.map((item) => item.title).filter(Boolean);
    const summary = typeof source.description === "string"
      ? source.description
      : typeof source.summary === "string" ? source.summary : "";
    const activityDescription = activities
      .map((item) => [item.time, item.title, item.detail].filter(Boolean).join(" "))
      .filter(Boolean)
      .join("；");
    const description = source.description ?? [summary && `${summary}。`, activityDescription].filter(Boolean).join("");
    const legacyMeals = source.meals && typeof source.meals === "object" && !Array.isArray(source.meals)
      ? source.meals as Record<string, unknown>
      : undefined;
    const mealDescriptions = Array.isArray(source.mealDescriptions)
      ? source.mealDescriptions
      : legacyMeals
        ? ["breakfast", "lunch", "dinner"].map((key) => `${key === "breakfast" ? "早餐" : key === "lunch" ? "午餐" : "晚餐"}${typeof legacyMeals[key] === "string" ? legacyMeals[key] : "自理"}`)
        : undefined;
    const meals = typeof source.meals === "string"
      ? source.meals
      : mealDescriptions?.join("；");
    const hotel = typeof source.hotel === "string" ? source.hotel : source.stay;
    return {
      day: source.day,
      title: source.title,
      spots,
      description,
      hotel,
      meals,
      ...(mealDescriptions ? { mealDescriptions } : {}),
      ...(hotel ? { hotelDescription: source.hotelDescription ?? hotel } : {}),
      ...(activities.length ? { activities } : {}),
    };
  });
}

// 把抓包中常见的路径变体映射回产品协议的标准路径。
/**
 * 把模型写出 / 抓包中常见的路径变体（basic_info/subtitle / transport_mode / presentation/desc
 * 等）映射回 /basicInfo/subtitle、/operations/transport 等产品标准 RFC6902 路径；
 * 若以 `/` 开头原样返回，否则在前面补一个 `/`。
 */
export function pathAlias(path: string): string {
  const aliases: Record<string, string> = {
    "basic_info/subtitle": "/basicInfo/subtitle",
    "basicInfo/destination": "/basicInfo/destinationCity",
    "/basic_info/subtitle": "/basicInfo/subtitle",
    "/operations/transport_mode": "/operations/transport",
    "operations/transport_mode": "/operations/transport",
    "transport-mode": "/operations/transport",
    "/transport-mode": "/operations/transport",
    "ops/transport": "/operations/transport",
    "presentation/desc": "/presentation",
    "/presentation/description": "/presentation",
  };
  if (aliases[path]) return aliases[path];
  if (!path.startsWith("/")) return `/${path}`;
  return path;
}

/**
 * 把外层包裹（如 {data: "..."} / {result: {...}} / {response: "..."}）解开，
 * 直到找到一个含 reply 字符串字段的对象为止；若顶层就是合法 AiResponse 形状则原样返回。
 * 任何一步都最多解开一层，避免无限递归。
 */
export function unwrapResponse(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.reply === "string") return value;
  for (const key of ["data", "result", "response", "output"]) {
    const nested = record[key];
    if (typeof nested === "string") {
      const parsed = parseRecoveredJson(nested);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).reply === "string") {
        return parsed;
      }
    } else if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const unwrapped = unwrapResponse(nested);
      if (unwrapped && typeof unwrapped === "object" && typeof (unwrapped as Record<string, unknown>).reply === "string") return unwrapped;
    }
  }
  return value;
}

/**
 * 把已经解包过的对象解析为严格类型的 AiResponse：
 *   - 强制 reply 非空字符串；
 *   - patch / questions / researchTasks 必须是数组（如果存在）；
 *   - 对每个 patch 操作做 pathAlias + zod 校验；
 *   - 任何一步不通过都抛 MiniMaxServiceError("invalid_model_output")。
 */
export function parseValue(value: unknown): AiResponse {
  const unwrapped = unwrapResponse(value);
  if (!unwrapped || typeof unwrapped !== "object" || Array.isArray(unwrapped)) throw new MiniMaxServiceError("invalid_model_output", "AI 返回的数据格式无法用于产品方案，请重试。");
  const record = unwrapped as Record<string, unknown>;
  const recordKeys = Object.fromEntries(
    aiResponsePayloadKeys
      .filter((key) => Object.prototype.hasOwnProperty.call(record, key))
      .map((key) => [key, record[key]]),
  );
  const reply = typeof recordKeys.reply === "string" ? recordKeys.reply.trim() : "";
  if (!reply) throw new MiniMaxServiceError("invalid_model_output", "AI 返回的数据格式无法用于产品方案，请重试。");
  if (recordKeys.patch !== undefined && !Array.isArray(recordKeys.patch)) {
    throw new MiniMaxServiceError("invalid_model_output", "AI 返回的数据格式无法用于产品方案，请重试。");
  }
  if (recordKeys.questions !== undefined && !Array.isArray(recordKeys.questions)) {
    throw new MiniMaxServiceError("invalid_model_output", "AI 返回的数据格式无法用于产品方案，请重试。");
  }
  if (recordKeys.researchTasks !== undefined && !Array.isArray(recordKeys.researchTasks)) {
    throw new MiniMaxServiceError("invalid_model_output", "AI 返回的数据格式无法用于产品方案，请重试。");
  }

  const rawPatch = Array.isArray(recordKeys.patch) ? recordKeys.patch : [];
  const patch = rawPatch
    .flatMap((operation) => {
      // 在 schema 校验前先把路径变体映射回产品协议的标准路径。
      if (operation && typeof operation === "object" && !Array.isArray(operation)) {
        const op = operation as Record<string, unknown>;
        if (typeof op.path === "string") op.path = pathAlias(op.path);
      }
      const parsed = patchOperationSchema.safeParse(operation);
      if (!parsed.success) return [];
      const normalised = normalisePatchOperation(parsed.data);
      return normalised ? [normalised] : [];
    });
  const rejectedPatchPaths = rawPatch.flatMap((operation) => {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) return ["[invalid operation]"];
    const path = (operation as Record<string, unknown>).path;
    return patchOperationSchema.safeParse(operation).success ? [] : [typeof path === "string" ? path : "[missing path]"];
  });
  if (rejectedPatchPaths.length) logWarn("[AI] rejected patch paths", { paths: rejectedPatchPaths });

  const questions = Array.isArray(recordKeys.questions)
    ? recordKeys.questions.filter((question): question is string => typeof question === "string" && Boolean(question.trim())).slice(0, 1)
    : [];
  const researchTasks = Array.isArray(recordKeys.researchTasks)
    ? recordKeys.researchTasks.flatMap((task) => {
      const parsed = researchTaskSchema.safeParse(task);
      return parsed.success ? [parsed.data] : [];
    })
    : [];
  const parsed = aiResponseSchema.safeParse({ reply, patch, questions, researchTasks });
  if (!parsed.success) throw new MiniMaxServiceError("invalid_model_output", "AI 返回的数据格式无法用于产品方案，请重试。");
  return parsed.data;
}
