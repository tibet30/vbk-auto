/**
 * 规划子系统 research 阶段的本地任务生成器。
 *
 *  - 完全 deterministic：不调用 AI，不依赖 model 输出；
 *  - 按产品当前已落地模块 + 已存在的 research tasks 计算 pending 集合；
 *  - 输出每条任务都标注「不可被 AI 解决」（运营 / VBK 才能确认 / 解决）。
 *
 *  阶段产物（researchTasks）会被 orchestrator 透传给 runtime.addResearchTask
 *  落库；这里不写任何产品字段。
 */

import type { ResearchTaskProposal, PlanningSkeleton, PlanningModule } from "../../shared/contracts-planning.js";
import { HOTEL_TIER_VALUES } from "../../shared/hotel-tiers.js";
import { poiResearchTaskLabel } from "../../shared/poi-research-tasks.js";
import { hasSatisfiedHotelTier, hasSatisfiedVehicleResource } from "../../shared/research-task-satisfaction.js";

const TASK_TYPE_VBK = "vbk" as const;
const TASK_TYPE_IMAGE = "image" as const;

interface PendingEvaluation {
  /** 用于 product 内部 task 去重的稳定 key。 */
  key: string;
  proposal: ResearchTaskProposal;
}

/**
 * 计算当前产品需要补齐的 research task 候选清单。
 *
 *  规则：
 *  - 行程里出现的城市 / 景点 → VBK 核查（city / POI）。
 *  - 私家团 → 用车资源组待核查；酒店档次 → 酒店档次核查。
 *  - 商业模块在规划 / 草稿阶段不生成强制人工核查任务，上架时在 VBK 核算。
 *  - presentation.cover 缺失 → image 任务（仅当 cover 未填时）。
 *
 *  每条任务都以 label + type 区分；去重交给 runtime.addResearchTask 完成。
 */
export function planResearchTasks(args: {
  skeleton: PlanningSkeleton;
  product: Record<string, unknown>;
  acceptedModules: readonly PlanningModule[];
}): PendingEvaluation[] {
  const { skeleton, product } = args;
  const pending: PendingEvaluation[] = [];
  // 用车：私家团必须；其它形态不强求
  if (skeleton.productForm === "privateTour" && !hasSatisfiedVehicleResource(product)) {
    pending.push({
      key: "vehicle::resourceGroup",
      proposal: {
        label: "核查用车资源组（按目的地 / 出行人数）",
        type: TASK_TYPE_VBK,
        detail: "私家团在 VBK 资源库确认 resourceGroupId",
      },
    });
  }

  // 酒店档次：/ -38 / -4 / -3 都需要资源匹配
  const operations = product.operations as Record<string, unknown> | undefined;
  const hotelTier = typeof operations?.hotelTier === "string" ? operations.hotelTier : "";
  const matchedTier = HOTEL_TIER_VALUES.find((value) => value === hotelTier);
  if (!hasSatisfiedHotelTier(product)) {
    pending.push({
      key: matchedTier ? `hotel::${matchedTier}` : "hotel::tier",
      proposal: {
        label: matchedTier ? `核查 ${matchedTier} 在 VBK 的酒店资源` : "核查酒店档次配置",
        type: TASK_TYPE_VBK,
        detail: matchedTier ? "由骨架目的地 + 档次匹配候选酒店资源" : "缺少合法酒店档次，需先确认 operations.hotelTier",
      },
    });
  }

  // presentation.cover 缺失 → image 任务
  const presentation = product.presentation as Record<string, unknown> | undefined;
  const cover = presentation?.cover;
  if (!cover || typeof cover !== "object" || Array.isArray(cover)) {
    pending.push({
      key: "cover::image",
      proposal: {
        label: "获取产品封面图（ctripLibrary 或人工上传）",
        type: TASK_TYPE_IMAGE,
      },
    });
  }

  return pending;
}

export function itineraryPoiTasks(itinerary: unknown, destination: string): ResearchTaskProposal[] {
  const seen = new Set<string>(); const out: ResearchTaskProposal[] = [];
  for (const day of Array.isArray(itinerary) ? itinerary : []) {
    const record = day && typeof day === "object" ? day as Record<string, unknown> : {};
    const rawItems: unknown[] = [];
    for (const key of ["spots", "poi", "attractions"]) {
      const value = record[key]; if (Array.isArray(value)) rawItems.push(...value); else if (value) rawItems.push(value);
    }
    if (Array.isArray(record.activities)) rawItems.push(...record.activities);
    for (const raw of rawItems) {
      const name = typeof raw === "string" ? raw.trim() : raw && typeof raw === "object" ? String((raw as any).poiName ?? (raw as any).name ?? (raw as any).title ?? "").trim() : "";
      if (!name || seen.has(name)) continue; seen.add(name);
      out.push({ label: poiResearchTaskLabel(name), type: TASK_TYPE_VBK, detail: `由目的地「${destination}」延伸` });
    }
  }
  return out;
}

/**
 * 把 planResearchTasks 的输出过滤成「当前未落地」的子集：
 * runtime 会用 label+type 去重，重复 key 自然合并；这里仍保留一份本地
 * 过滤以减少 IPC 流量。
 */
export function pendingResearchTasks(args: {
  skeleton: PlanningSkeleton;
  product: Record<string, unknown>;
  acceptedModules: readonly PlanningModule[];
  existing: ReadonlyArray<Pick<ResearchTaskProposal, "label" | "type">>;
}): PendingEvaluation[] {
  const candidates = planResearchTasks(args);
  const seen = new Set<string>();
  for (const task of args.existing) {
    seen.add(`${task.type}::${task.label}`);
  }
  return candidates.filter((entry) => !seen.has(`${entry.proposal.type}::${entry.proposal.label}`));
}
