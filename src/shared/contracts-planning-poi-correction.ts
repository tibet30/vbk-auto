/** 用户输入疑似错别字或别名时，仅用于生成后续的安全搜索词。 */
export interface PlanningPoiNameCorrectionRequest {
  requestedName: string;
  destination: string;
  province: string;
  city: string;
  preferredDay?: number;
  userIdea?: string;
}

export interface PlanningPoiNameCorrectionResult {
  /** 按可信度排序，不能含原始输入或 POI ID。 */
  terms: string[];
  confidence: number;
  reason: string;
}
