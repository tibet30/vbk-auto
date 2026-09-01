export interface PlanningPoiDisambiguationCandidate {
  /** 本轮候选列表内的临时编号；AI 不接触、也不能生成真实 POI ID。 */
  candidateId: string;
  poiName: string;
  province?: string;
  city?: string;
  district?: string;
  address?: string;
}

export interface PlanningPoiDisambiguationRequest {
  requestedName: string;
  destination: string;
  province: string;
  city: string;
  preferredDay?: number;
  userIdea?: string;
  candidates: PlanningPoiDisambiguationCandidate[];
}

export interface PlanningPoiDisambiguationResult {
  decision: "selected" | "uncertain";
  candidateId?: string;
  confidence: number;
  reason: string;
}
