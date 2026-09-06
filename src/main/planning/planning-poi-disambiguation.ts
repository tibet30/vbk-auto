import type {
  PlanningPoiCandidate,
  PlanningPoiDisambiguationRequest,
  PlanningPoiDisambiguationResult,
} from "../../shared/contracts-planning.js";
import type { PoiSuggestDetailResult, PoiSuggestion } from "../../shared/contracts-types.js";
import { chooseUsablePoiOptions } from "./poi-usable-choices.js";

interface PoiDisambiguationArgs {
  requestedName: string;
  destination: string;
  province: string;
  city: string;
  userIdea?: string;
  preferredDay?: number;
  details: PoiSuggestDetailResult[];
  disambiguate(request: PlanningPoiDisambiguationRequest): Promise<PlanningPoiDisambiguationResult>;
  validate(detail: PoiSuggestDetailResult, best: PoiSuggestion): PlanningPoiCandidate;
  checkAvailability?: (poiId: number) => Promise<{ status: "available" | "suspended" }>;
}

interface VerifiedChoice {
  candidateId: string;
  candidate: PlanningPoiCandidate;
}

/**
 * AI 只在已由携程返回、通过本地域校验、且营业可用的候选中做选择。
 * 真实 poiId 始终留在本地映射中，不进入模型输出契约。
 */
export async function resolveAmbiguousPlanningPoi(
  args: PoiDisambiguationArgs,
): Promise<{ candidate?: PlanningPoiCandidate; reason?: string }> {
  const verified = verifiedChoices(args);
  if (verified.length === 0) return {};
  const choices = await filterUsableChoices(verified, args.checkAvailability);
  if (choices.length === 0) {
    const decision = chooseUsablePoiOptions(verified.map((choice) => ({
      name: choice.candidate.poiName || args.requestedName,
      usable: false,
      reason: "暂停营业或不可用",
      poiId: choice.candidate.poiId,
    })));
    return { reason: decision.kind === "ask" ? decision.summary : "候选地点均不可用" };
  }
  if (choices.length === 1) {
    return {
      candidate: {
        ...choices[0]!.candidate,
        reason: "唯一可用候选，已自动采用",
      },
    };
  }
  try {
    const outcome = await args.disambiguate({
      requestedName: args.requestedName,
      destination: args.destination,
      province: args.province,
      city: args.city,
      preferredDay: args.preferredDay,
      userIdea: args.userIdea,
      candidates: choices.map(({ candidateId, candidate }) => ({
        candidateId,
        poiName: candidate.poiName!,
        province: candidate.province,
        city: candidate.city,
        district: candidate.district,
        address: candidate.address,
      })),
    });
    const selected = outcome.decision === "selected"
      ? choices.find((choice) => choice.candidateId === outcome.candidateId)
      : undefined;
    if (!selected) {
      return { reason: ambiguousReason(choices, outcome.reason) };
    }
    return {
      candidate: {
        ...selected.candidate,
        reason: `AI 消歧：${outcome.reason}（置信度 ${outcome.confidence.toFixed(2)}）`,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { reason: `AI 消歧失败：${message.slice(0, 160)}` };
  }
}

async function filterUsableChoices(
  choices: VerifiedChoice[],
  checkAvailability?: (poiId: number) => Promise<{ status: "available" | "suspended" }>,
): Promise<VerifiedChoice[]> {
  if (!checkAvailability) return choices;
  const usable: VerifiedChoice[] = [];
  for (const choice of choices) {
    const poiId = choice.candidate.poiId;
    if (!poiId) continue;
    try {
      const availability = await checkAvailability(poiId);
      if (availability.status === "available") usable.push(choice);
    } catch {
      // 可用性查询失败时不把该候选交给用户/模型选择。
    }
  }
  return usable;
}

function verifiedChoices(args: PoiDisambiguationArgs): VerifiedChoice[] {
  const requested = normaliseName(args.requestedName);
  const seen = new Set<number>();
  const result: VerifiedChoice[] = [];
  for (const detail of args.details) {
    for (const raw of detail.candidates) {
      if (result.length >= 12) return result;
      const poiId = raw.poiId;
      const poiName = raw.poiName?.trim();
      if (!raw.selectable || !poiName || !poiId || seen.has(poiId)) continue;
      if (!namesAreRelated(requested, normaliseName(poiName))) continue;
      const candidate = args.validate(detail, { poiId, poiName });
      if (candidate.status !== "resolved" || !candidate.poiId || !candidate.poiName) continue;
      seen.add(candidate.poiId);
      result.push({ candidateId: `candidate-${result.length + 1}`, candidate });
    }
  }
  return result;
}

function namesAreRelated(requested: string, candidate: string): boolean {
  if (!requested || !candidate) return false;
  return candidate.includes(requested) || requested.includes(candidate);
}

function normaliseName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s·•・—_()（）【】\[\]]/g, "");
}

function ambiguousReason(choices: VerifiedChoice[], aiReason: string): string {
  const names = choices.slice(0, 3).map((choice) => choice.candidate.poiName).join("、");
  const suffix = aiReason.trim() ? `；AI 判断：${aiReason.trim()}` : "";
  return `存在多个同城真实 POI（${names}），仍无法确定大众常游主景点${suffix}`;
}
