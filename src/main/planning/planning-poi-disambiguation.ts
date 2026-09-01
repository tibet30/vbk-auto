import type {
  PlanningPoiCandidate,
  PlanningPoiDisambiguationRequest,
  PlanningPoiDisambiguationResult,
} from "../../shared/contracts-planning.js";
import type { PoiSuggestDetailResult, PoiSuggestion } from "../../shared/contracts-types.js";

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
}

interface VerifiedChoice {
  candidateId: string;
  candidate: PlanningPoiCandidate;
}

/**
 * AI 只在已由携程返回、且通过本地域校验的候选中做选择。真实 poiId 始终
 * 留在本地映射中，不进入模型输出契约，避免模型生成或篡改 POI 身份。
 */
export async function resolveAmbiguousPlanningPoi(
  args: PoiDisambiguationArgs,
): Promise<{ candidate?: PlanningPoiCandidate; reason?: string }> {
  const choices = verifiedChoices(args);
  if (choices.length === 0) return {};
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
