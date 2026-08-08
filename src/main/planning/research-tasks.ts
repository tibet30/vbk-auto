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

const TASK_TYPE_VBK = "vbk" as const;
const TASK_TYPE_WEB = "web" as const;
const TASK_TYPE_COST = "cost" as const;
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
 *  - 私家团 → 用车资源组待核查；酒店档次 → 酒店资源核查。
 *  - 商业模块：pricing / inventory 各自的 VBK / cost 核查；
 *  - presentation.cover 缺失 → image 任务（仅当 cover 未填时）。
 *
 *  每条任务都以 label + type 区分；去重交给 runtime.addResearchTask 完成。
 */
export function planResearchTasks(args: {
  skeleton: PlanningSkeleton;
  product: Record<string, unknown>;
  acceptedModules: readonly PlanningModule[];
}): PendingEvaluation[] {
  const { skeleton, product, acceptedModules } = args;
  const pending: PendingEvaluation[] = [];
  const productItinerary = Array.isArray(product.itinerary)
    ? (product.itinerary as Array<Record<string, unknown>>)
    : [];
  const commercial = product.commercial as Record<string, unknown> | undefined;

  // 行程里出现的城市 / POI → VBK 核查
  const seenSpotKeys = new Set<string>();
  for (const day of productItinerary) {
    const spots = Array.isArray(day?.spots) ? (day.spots as unknown[]) : [];
    for (const raw of spots) {
      if (typeof raw !== "string") continue;
      const text = raw.trim();
      if (!text) continue;
      const key = `city-poi::${text}`;
      if (seenSpotKeys.has(key)) continue;
      seenSpotKeys.add(key);
      pending.push({
        key,
        proposal: {
          label: `核查 ${text} 在 VBK 资源库的 city / poi 映射`,
          type: TASK_TYPE_VBK,
          detail: `由骨架目的地「${skeleton.destination}」延伸`,
        },
      });
    }
  }

  // 用车：私家团必须；其它形态不强求
  if (skeleton.productForm === "privateTour") {
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
  if (matchedTier) {
    pending.push({
      key: `hotel::${matchedTier}`,
      proposal: {
        label: `核查 ${matchedTier} 在 VBK 的酒店资源`,
        type: TASK_TYPE_VBK,
        detail: "由骨架目的地 + 档次匹配候选酒店资源",
      },
    });
  }

  // 商业模块：pricing / inventory 各自的 VBK / cost 核查
  if (acceptedModules.includes("pricing") || commercial?.pricing) {
    pending.push({
      key: "pricing::vbk",
      proposal: {
        label: "核查成人价 / 儿童价 / 起订人数在 VBK 是否可发布",
        type: TASK_TYPE_VBK,
      },
    });
  }
  if (acceptedModules.includes("inventory") || commercial?.inventory) {
    pending.push({
      key: "inventory::vbk",
      proposal: {
        label: "核查库存起止日期与每日配额在 VBK 是否生效",
        type: TASK_TYPE_VBK,
      },
    });
  }
  if (acceptedModules.includes("packageName") || (commercial?.packageName && typeof commercial.packageName === "string")) {
    pending.push({
      key: "packageName::web",
      proposal: {
        label: "核查套餐名称与公开渠道展示一致",
        type: TASK_TYPE_WEB,
      },
    });
  }
  if (acceptedModules.includes("terms") || commercial?.terms) {
    pending.push({
      key: "terms::cost",
      proposal: {
        label: "核查费用包含 / 不包含 / 退改政策的运营成本口径",
        type: TASK_TYPE_COST,
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
