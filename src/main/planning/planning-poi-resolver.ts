import type { PlanningPoiCandidate, PlanningPoiDisambiguationRequest, PlanningPoiDisambiguationResult, PlanningPoiNameCorrectionRequest, PlanningPoiNameCorrectionResult } from "../../shared/contracts-planning.js";
import type { PoiSuggestDetailResult } from "../../shared/contracts-types.js";
import { logInfo, logWarn } from "../../shared/log-timestamp.js";
import { resolveAmbiguousPlanningPoi } from "./planning-poi-disambiguation.js";
import { toPlanningCandidate } from "./planning-v2-pois.js";

export interface PlanningPoiLogContext {
  localProductId?: string;
  productName?: string;
  stage?: string;
  phase?: string;
}

export function logPlanningPoiEvent(
  context: PlanningPoiLogContext | undefined,
  event: string,
  details: Record<string, unknown>,
  level: "info" | "warn" = "info",
): void {
  const payload = {
    ...context,
    stage: context?.stage ?? "planning",
    phase: context?.phase ?? "poiResolution",
    ...details,
  };
  if (level === "warn") logWarn(`[planning:poi] ${event}`, payload);
  else logInfo(`[planning:poi] ${event}`, payload);
}

export async function resolvePlanningPoiCandidates(args: {
  names: string[];
  province: string;
  city: string;
  concurrency?: number;
  beforeEach: () => Promise<void>;
  query: (name: string) => Promise<PoiSuggestDetailResult>;
  checkAvailability?: (poiId: number) => Promise<{ status: "available" | "suspended" }>;
  destination?: string;
  userIdea?: string;
  shouldDisambiguate?: (requestedName: string, index: number) => boolean;
  preferredDay?: (requestedName: string, index: number) => number | undefined;
  disambiguate?: (request: PlanningPoiDisambiguationRequest) => Promise<PlanningPoiDisambiguationResult>;
  correctName?: (request: PlanningPoiNameCorrectionRequest) => Promise<PlanningPoiNameCorrectionResult>;
  logContext?: PlanningPoiLogContext;
}): Promise<PlanningPoiCandidate[]> {
  const result = new Array<PlanningPoiCandidate>(args.names.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < args.names.length) {
      const index = cursor;
      cursor += 1;
      const requestedName = args.names[index];
      const startedAt = Date.now();
      try {
        await args.beforeEach();
        const detail = await args.query(requestedName);
        const details = [detail];
        let candidate = toPlanningCandidate(requestedName, detail, args.province, args.city);
        logPlanningPoiEvent(args.logContext, "查询结果", {
          target: requestedName, query: requestedName, queryMode: "原始名称", ...detailSummary(detail), ...candidateSummary(candidate),
        });
        const originallyAmbiguous = candidate.status === "rejected"
          && (candidate.reason === "未命中可确认的真实 POI" || candidate.reason?.startsWith("POI 地域不匹配"));
        const cityQualifiedName = `${args.city.trim()}${requestedName}`;
        if (originallyAmbiguous && args.city.trim() && !requestedName.startsWith(args.city.trim())) {
          await args.beforeEach();
          const cityDetail = await args.query(cityQualifiedName);
          details.push(cityDetail);
          candidate = toPlanningCandidate(requestedName, cityDetail, args.province, args.city);
          logPlanningPoiEvent(args.logContext, "查询结果", {
            target: requestedName, query: cityQualifiedName, queryMode: "城市前缀重试", ...detailSummary(cityDetail), ...candidateSummary(candidate),
          });
        }
        if (candidate.reason === "未命中可确认的真实 POI" && args.correctName && args.shouldDisambiguate?.(requestedName, index)) {
          candidate = await resolveCorrectedName({ args, requestedName, index, candidate, details });
        }
        if (args.disambiguate && originallyAmbiguous && !candidate.reason?.startsWith("名称纠正：") && args.shouldDisambiguate?.(requestedName, index)) {
          const resolved = await resolveAmbiguousPlanningPoi({
            requestedName, destination: args.destination || args.city, province: args.province, city: args.city,
            userIdea: args.userIdea, preferredDay: args.preferredDay?.(requestedName, index), details,
            disambiguate: args.disambiguate,
            validate: (source, best) => toPlanningCandidate(requestedName, { ...source, best }, args.province, args.city),
            ...(args.checkAvailability ? { checkAvailability: args.checkAvailability } : {}),
          });
          if (resolved.candidate) candidate = resolved.candidate;
          else if (resolved.reason) candidate = { ...candidate, reason: resolved.reason };
          logPlanningPoiEvent(args.logContext, "消歧结论", {
            target: requestedName, detailCount: details.length, ...candidateSummary(candidate),
          }, candidate.status === "rejected" ? "warn" : "info");
        }
        if (candidate.status === "resolved" && candidate.poiId && args.checkAvailability) {
          const availability = await args.checkAvailability(candidate.poiId);
          result[index] = availability.status === "suspended"
            ? { requestedName, status: "rejected", poiId: candidate.poiId, poiName: candidate.poiName, reason: "携程景点详情标记为暂停营业" }
            : candidate;
          logPlanningPoiEvent(args.logContext, "营业状态", {
            target: requestedName, poiId: candidate.poiId, poiName: candidate.poiName, availability: availability.status,
          }, availability.status === "suspended" ? "warn" : "info");
        } else result[index] = candidate;
        logPlanningPoiEvent(args.logContext, "核验结论", {
          target: requestedName, durationMs: Date.now() - startedAt, ...candidateSummary(result[index]),
        }, result[index].status === "rejected" ? "warn" : "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/登录|Cookie|cookie|未登录/.test(message)) throw error;
        result[index] = { requestedName, status: "rejected", reason: `POI 查询失败：${message.slice(0, 160)}` };
        logPlanningPoiEvent(args.logContext, "查询异常", {
          target: requestedName, durationMs: Date.now() - startedAt, reason: result[index].reason,
        }, "warn");
      }
    }
  };
  const workerCount = Math.min(Math.max(1, args.concurrency ?? 5), args.names.length || 1);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return result;
}

async function resolveCorrectedName(args: {
  args: Parameters<typeof resolvePlanningPoiCandidates>[0];
  requestedName: string;
  index: number;
  candidate: PlanningPoiCandidate;
  details: PoiSuggestDetailResult[];
}): Promise<PlanningPoiCandidate> {
  let correction: PlanningPoiNameCorrectionResult;
  try {
    correction = await args.args.correctName!({
      requestedName: args.requestedName, destination: args.args.destination || args.args.city,
      province: args.args.province, city: args.args.city, userIdea: args.args.userIdea,
      preferredDay: args.args.preferredDay?.(args.requestedName, args.index),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logPlanningPoiEvent(args.args.logContext, "名称纠正失败", {
      target: args.requestedName, reason: message.slice(0, 160),
    }, "warn");
    return args.candidate;
  }
  logPlanningPoiEvent(args.args.logContext, "名称纠正建议", {
    target: args.requestedName, terms: correction.terms, confidence: correction.confidence, reason: correction.reason,
  }, correction.terms.length ? "info" : "warn");
  const matches = new Map<number, { term: string; candidate: PlanningPoiCandidate }>();
  for (const term of correction.terms) {
    await args.args.beforeEach();
    const detail = await args.args.query(term);
    args.details.push(detail);
    const candidate = toPlanningCandidate(args.requestedName, detail, args.args.province, args.args.city);
    logPlanningPoiEvent(args.args.logContext, "名称纠正查询", {
      target: args.requestedName, query: term, queryMode: "名称纠正", ...detailSummary(detail), ...candidateSummary(candidate),
    });
    if (candidate.status === "resolved" && candidate.poiId) matches.set(candidate.poiId, { term, candidate });
  }
  if (matches.size === 1) {
    const { term, candidate } = [...matches.values()][0];
    return { ...candidate, reason: `名称纠正：用户输入「${args.requestedName}」按「${term}」匹配（置信度 ${correction.confidence.toFixed(2)}）` };
  }
  if (matches.size > 1) {
    return { ...args.candidate, reason: `名称疑似有误，纠正词命中多个真实 POI（${[...matches.values()].map((match) => match.candidate.poiName).join("、")}），请用户确认` };
  }
  return correction.terms.length
    ? { ...args.candidate, reason: `名称疑似有误，已尝试纠正词「${correction.terms.join("、")}」仍未命中可确认的真实 POI` }
    : args.candidate;
}

function detailSummary(detail: PoiSuggestDetailResult): Record<string, unknown> {
  return {
    candidateCount: detail.candidates.length,
    bestPoiId: detail.best?.poiId,
    bestPoiName: detail.best?.poiName?.trim(),
  };
}

function candidateSummary(candidate: PlanningPoiCandidate): Record<string, unknown> {
  return {
    resultStatus: candidate.status,
    poiId: candidate.poiId,
    poiName: candidate.poiName,
    province: candidate.province,
    city: candidate.city,
    reason: candidate.reason,
  };
}
