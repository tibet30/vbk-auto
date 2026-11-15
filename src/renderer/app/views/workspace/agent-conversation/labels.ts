import type { AgentEvent, AgentRunStatus } from "../../../../../shared/contracts";

export const STATUS: Record<AgentRunStatus, string> = {
  queued: "等待执行", running: "正在处理", waiting_input: "等待你的回答", waiting_approval: "等待最终确认",
  paused: "任务已暂停", completed: "任务已完成", failed: "需要处理", abandoned: "任务已废弃",
};

export const EVENT_LABEL: Record<AgentEvent["type"], string> = {
  user: "我", assistant: "小助手", tool_call: "执行动作", tool_result: "执行结果", status: "任务状态",
  input_request: "需要补充", approval_request: "方案待确认", approval: "确认记录",
};

export const ACTION_NAMES: Record<string, string> = {
  ask_user: "询问需要补充的信息", request_approval: "准备最终确认", resolve_itinerary_pois: "核验行程景点",
  read_product: "读取当前产品", generate_product_module: "完善产品模块", ensure_presentation_recommendations: "核验推荐理由", patch_product: "更新本地方案",
  query_poi: "查询景点", select_itinerary_poi: "设置行程景点", query_hotel_resource: "查询酒店资源",
  resolve_itinerary_hotels: "匹配行程酒店", resolve_cover: "匹配产品封面", query_vehicle_resource: "查询用车资源",
  resolve_vehicle_resource: "匹配用车资源", query_station: "查询交通站点", recheck_traffic_line_availability: "重新核验大交通", read_vbk_phase: "核对 VBK 结果",
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

export function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export function actionLabel(name: string): string {
  return ACTION_NAMES[name] ?? name;
}

export function moduleStageLabel(stage: string): string {
  return MODULE_STAGE_NAMES[stage] ?? stage;
}

export function statusText(event: AgentEvent): string {
  return STATUS[event.content as AgentRunStatus] ?? event.content;
}

export function toolCallLabel(call: AgentEvent): string {
  const name = typeof call.data?.name === "string" ? call.data.name : call.content;
  const base = actionLabel(name);
  const args = call.data?.arguments && typeof call.data.arguments === "object" && !Array.isArray(call.data.arguments)
    ? call.data.arguments as Record<string, unknown>
    : undefined;
  if (name === "query_poi") {
    const keyword = typeof args?.keyword === "string" ? args.keyword.trim() : "";
    return keyword ? `${base} · ${keyword}` : base;
  }
  if (name === "query_station") {
    const keyword = typeof args?.keyword === "string" ? args.keyword.trim() : "";
    const kindLabel = args?.kind === "airport" ? "查询机场" : args?.kind === "train" ? "查询火车站" : base;
    return keyword ? `${kindLabel} · ${keyword}` : kindLabel;
  }
  if (name === "generate_product_module") {
    const stage = typeof args?.stage === "string" ? args.stage.trim() : "";
    const stageLabel = moduleStageLabel(stage);
    return stageLabel ? `${base} · ${stageLabel}` : base;
  }
  if (name === "execute_vbk_phase") {
    const phase = typeof args?.phase === "string" ? args.phase.trim() : "";
    const phaseLabel = moduleStageLabel(phase);
    return phaseLabel ? `${base} · ${phaseLabel}` : base;
  }
  return base;
}
