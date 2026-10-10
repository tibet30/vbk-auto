/**
 * 三阶段产品规划树的常量映射：
 *   - STAGES：foundation / itinerary / completion 三阶段元数据 + 重做后失效范围；
 *   - NODE_LABELS：每个 PlanningNodeId 对应的中文文案；
 *   - RERUN_FALLBACK_NODES：重做某阶段时高亮的入口节点（foundation → skeleton 等）；
 *   - STATUS_LABELS：每个节点 status 的中文文案。
 */

import type { PlanningMajorStage, PlanningNodeId, PlanningNodeState } from "../../../../../shared/contracts-planning";
import type { PlanningRerunStage } from "../planning-rerun-confirm-dialog";

export const STAGES: PlanningRerunStage[] = [
  { id: "foundation", label: "产品骨架", description: "省市、天数、形态与交通骨架", invalidates: "产品骨架、行程规划和全部产品补全数据" },
  { id: "itinerary", label: "行程规划", description: "候选景点、真实 POI、逐日编排与酒店匹配", invalidates: "景点池、POI、逐日行程、酒店候选和全部产品补全数据" },
  { id: "completion", label: "产品补全", description: "文案、商业信息、封面与用车资源", invalidates: "副标题、展示、商业信息、封面和用车资源组" },
];

export const NODE_LABELS: Record<PlanningNodeId, string> = {
  skeleton: "解析并写入骨架",
  spotCandidates: "AI 推荐景点池",
  poiResolution: "查询真实 POI",
  itineraryDraft: "编排每天行程",
  hotelResolution: "匹配每日酒店候选",
  copy: "副标题 / Operation Notes",
  presentation: "推荐语 / 卖点 / 分类",
  commercial: "套餐 / 价格 / 库存 / Release",
  cover: "真实封面",
  vehicleResource: "私家团用车资源组",
  finalValidation: "最终准入检查",
};

export const RERUN_FALLBACK_NODES: Record<PlanningMajorStage, PlanningNodeId> = {
  foundation: "skeleton",
  itinerary: "spotCandidates",
  completion: "copy",
};

export const STATUS_LABELS: Record<PlanningNodeState["status"], string> = {
  pending: "待开始",
  running: "进行中",
  completed: "已完成",
  failed: "未通过",
  blocked: "被阻塞",
  skipped: "不适用",
  invalidated: "已失效",
};