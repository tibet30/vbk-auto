/**
 * 把 productSchema 的 zod 校验错误转成面向运营的中文待处理项。
 *
 * zod 默认 message 是英文（"Too small: expected string to have >=2 characters"），
 * path 是字段路径（"basicInfo.subtitle"），不能直接展示在「待处理事项」里。
 * 这里统一：path → 中文字段名，issue → 中文说明；自定义 message（已是中文）原样保留。
 */
import type { ProductReadiness } from "../shared/contracts.js";

type ZodIssueLike = {
  code?: string;
  path: ReadonlyArray<PropertyKey>;
  message: string;
  origin?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  inclusive?: boolean;
  expected?: string;
  values?: ReadonlyArray<unknown>;
  format?: string;
};

const SEGMENT_LABELS: Record<string, string> = {
  sales: "销售信息",
  productType: "产品类型",
  productForm: "产品形态",
  splitGroup: "拼团",
  squareGroup: "广场团",
  maxGroupSize: "最大成团人数",
  guideIncluded: "随团导游",
  basicInfo: "基本信息",
  supplierProductName: "供应商产品名称",
  supplierProductCode: "供应商产品编号",
  subtitle: "副标题",
  days: "行程天数",
  nights: "行程晚数",
  meetingCity: "集合城市",
  destinationCity: "目的地城市",
  province: "国家景区（省份）",
  operationNotes: "运营备注",
  userIdea: "用户想法",
  ideaOptimization: "想法优化",
  presentation: "展示信息",
  recommendation: "推荐语",
  recommendations: "推荐语",
  cover: "产品封面",
  sizeBytes: "文件大小",
  operations: "运营配置",
  commercial: "商务信息",
  pricing: "套餐定价",
  inventory: "库存班期",
  release: "发布控制",
  terms: "预订条款",
  manualReview: "人工审核",
  itinerary: "每日行程",
  title: "标题",
  description: "描述",
  spots: "景点",
  hotel: "酒店",
  hotelCandidates: "酒店候选",
  meals: "餐食",
  transport: "交通",
  name: "名称",
  time: "时间",
  day: "天数",
  adult: "成人价",
  child: "儿童价",
  minimumTravelers: "起订人数",
  startDate: "起始日期",
  endDate: "结束日期",
  dailyQuota: "每日配额",
  bookingNotes: "预订须知",
  cancellationPolicy: "取消政策",
  changePolicy: "改期政策",
  refundPolicy: "退款政策",
  inclusions: "费用包含",
  exclusions: "费用不含",
};

/** 字段路径 → 中文标签；数字段在每日行程下读作「第 N 天」，其余读作「第 N 项」。 */
export function schemaPathLabel(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return "产品方案";
  const parts: string[] = [];
  path.forEach((segment, index) => {
    if (typeof segment === "number") {
      parts.push(path[index - 1] === "itinerary" ? `第 ${segment + 1} 天` : `第 ${segment + 1} 项`);
      return;
    }
    const key = String(segment);
    parts.push(SEGMENT_LABELS[key] ?? key);
  });
  return parts.join(" · ");
}

const ORIGIN_UNIT: Record<string, { noun: string; unit: string }> = {
  string: { noun: "内容", unit: " 个字符" },
  array: { noun: "列表", unit: " 项" },
  set: { noun: "列表", unit: " 项" },
  number: { noun: "数值", unit: "" },
  int: { noun: "数值", unit: "" },
};

function limitText(issue: ZodIssueLike, kind: "min" | "max"): string {
  const origin = ORIGIN_UNIT[issue.origin ?? ""];
  const bound = kind === "min" ? issue.minimum : issue.maximum;
  const inclusive = issue.inclusive !== false;
  if (bound === undefined || !origin) return kind === "min" ? "内容过少" : "内容过长";
  const value = `${bound}${origin.unit}`;
  if (origin.unit) {
    if (kind === "min") return inclusive ? `${origin.noun}至少需要 ${value}` : `${origin.noun}需多于 ${value}`;
    return inclusive ? `${origin.noun}最多 ${value}` : `${origin.noun}需少于 ${value}`;
  }
  if (kind === "min") return inclusive ? `不能小于 ${value}` : `需大于 ${value}`;
  return inclusive ? `不能大于 ${value}` : `需小于 ${value}`;
}

const EXPECTED_LABELS: Record<string, string> = {
  string: "文本",
  number: "数字",
  int: "整数",
  boolean: "是/否",
  array: "列表",
  object: "对象",
};

/** 单条 zod issue 的中文说明；已是中文的自定义 message 原样返回。 */
export function schemaIssueDetail(issue: ZodIssueLike): string {
  if (/[一-龥]/.test(issue.message)) return issue.message;
  switch (issue.code) {
    case "too_small":
      return `${limitText(issue, "min")}，请补充后重试。`;
    case "too_big":
      return `${limitText(issue, "max")}，请精简后重试。`;
    case "invalid_type": {
      const expected = EXPECTED_LABELS[issue.expected ?? ""] ?? issue.expected ?? "有效值";
      return /received undefined|undefined/i.test(issue.message)
        ? `缺少必填项（需要${expected}），请补充后重试。`
        : `格式不正确（需要${expected}），请修正后重试。`;
    }
    case "invalid_value":
      return issue.values?.length
        ? `取值不在允许范围内（可选：${issue.values.map(String).join("、")}）。`
        : "取值不在允许范围内。";
    case "invalid_format":
      return "格式不正确，请修正后重试。";
    case "unrecognized_keys":
      return "包含系统不识别的字段，请移除后重试。";
    default:
      return "内容未通过校验，请核查后重试。";
  }
}

export function schemaIssueToReadinessIssue(issue: ZodIssueLike): ProductReadiness["issues"][number] {
  return { label: schemaPathLabel(issue.path), detail: schemaIssueDetail(issue) };
}
