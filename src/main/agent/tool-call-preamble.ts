import type { AgentToolCall } from "./types.js";

const ACTION_NAMES: Record<string, string> = {
  ask_user: "询问需要补充的信息",
  request_approval: "准备最终确认",
  resolve_itinerary_pois: "核验行程景点",
  read_product: "读取当前产品",
  generate_product_module: "完善产品模块",
  ensure_presentation_recommendations: "核验推荐理由",
  patch_product: "更新本地方案",
  query_poi: "查询景点",
  select_itinerary_poi: "设置行程景点",
  query_hotel_resource: "查询酒店资源",
  resolve_itinerary_hotels: "匹配行程酒店",
  resolve_cover: "匹配产品封面",
  query_vehicle_resource: "查询用车资源",
  resolve_vehicle_resource: "匹配用车资源",
  query_station: "查询交通站点",
  recheck_traffic_line_availability: "重新核验大交通",
  read_vbk_phase: "核对 VBK 结果",
  execute_vbk_phase: "录入 VBK 模块",
};

const MODULE_STAGE_NAMES: Record<string, string> = {
  skeleton: "产品骨架",
  basicInfo: "基础信息",
  itinerary: "每日行程",
  presentation: "产品展示",
  commercial: "套餐与价格",
  saleControl: "创建草稿",
  basic: "基础信息",
  package: "套餐",
  pricingInventory: "价格与库存",
  hotelResource: "住宿资源",
  vehicleResource: "用车资源",
  terms: "条款",
  trafficLine: "大交通",
  preflight: "整体核验",
};

function textArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function actionLabel(name: string): string {
  return ACTION_NAMES[name] ?? name;
}

function callPurpose(call: AgentToolCall): string {
  const args = call.arguments;
  const base = actionLabel(call.name);
  if (call.name === "read_product") return "读取当前产品，确认已经填写的内容和还缺哪些信息";
  if (call.name === "generate_product_module") {
    const stage = textArg(args, "stage");
    const stageLabel = MODULE_STAGE_NAMES[stage] ?? stage;
    return stageLabel ? `完善${stageLabel}，把本地方案补齐到可审核状态` : "完善产品模块，把本地方案补齐到可审核状态";
  }
  if (call.name === "patch_product") return "更新本地方案，保存刚确认或生成的字段";
  if (call.name === "query_poi") {
    const keyword = textArg(args, "keyword");
    return keyword ? `查询景点「${keyword}」，核对平台里可用的 POI` : "查询景点，核对平台里可用的 POI";
  }
  if (call.name === "select_itinerary_poi") return "设置行程景点，把已确认的 POI 写回对应日程";
  if (call.name === "resolve_itinerary_pois") return "核验行程景点，确认每日景点都能匹配到平台 POI";
  if (call.name === "query_hotel_resource") return "查询酒店资源，确认住宿候选能否用于当前产品";
  if (call.name === "resolve_itinerary_hotels") return "匹配行程酒店，把住宿资源与每日安排对齐";
  if (call.name === "resolve_cover") return "匹配产品封面，选择适合当前线路的图片";
  if (call.name === "query_vehicle_resource") return "查询用车资源，确认车型与座位是否可用";
  if (call.name === "resolve_vehicle_resource") return "匹配用车资源，把车辆候选写入本地方案";
  if (call.name === "query_station") {
    const keyword = textArg(args, "keyword");
    const kind = args.kind === "airport" ? "机场" : args.kind === "train" ? "火车站" : "交通站点";
    return keyword ? `查询${kind}「${keyword}」，确认交通站点编码和名称` : `查询${kind}，确认交通站点编码和名称`;
  }
  if (call.name === "recheck_traffic_line_availability") return "重新核验大交通，确认车次或航班资源仍然可用";
  if (call.name === "read_vbk_phase") {
    const phase = textArg(args, "phase");
    const phaseLabel = MODULE_STAGE_NAMES[phase] ?? phase;
    return phaseLabel ? `核对 VBK 的${phaseLabel}结果，确认远端保存状态` : "核对 VBK 结果，确认远端保存状态";
  }
  if (call.name === "execute_vbk_phase") {
    const phase = textArg(args, "phase");
    const phaseLabel = MODULE_STAGE_NAMES[phase] ?? phase;
    return phaseLabel ? `录入 VBK 的${phaseLabel}模块，并在完成后回读核验` : "录入 VBK 模块，并在完成后回读核验";
  }
  if (call.name === "ask_user") return "向你确认缺失信息，避免自行猜测会改变结果的内容";
  if (call.name === "request_approval") return "准备最终确认，在你授权前不会录入 VBK";
  return `${base}，继续推进当前产品任务`;
}

export function formatToolCallPreamble(calls: AgentToolCall[]): string {
  const purposes = calls.map(callPurpose);
  if (purposes.length === 1) return `我先${purposes[0]}。`;
  return `接下来我会先做这几步：\n${purposes.map((purpose, index) => `${index + 1}. ${purpose}。`).join("\n")}`;
}
