/**
 * main.ts 公共类型 + 选项：
 *   - TrafficLineApiOptions：外部传入的 maxSegmentPolls / sleep / now /
 *     itinerary / endpointPlan / rejectedTrainStationCodes / childProgress
 *     各种回调 + disambiguator；
 *   - TrafficLineApiResult：返回的 children[] / skipped[] 数组。
 *
 * 拆出来避免 main.ts 同时承载类型与流程；process-target.ts 直接复用本类型。
 */

import type {
  TrafficLineChildProgress,
  TrafficLineEndpointPlan,
  TrafficLineVariant,
} from "../../../../shared/contracts-traffic-line.js";
import type { TrafficLineStationDisambiguator } from "./endpoints.js";
import type { TrafficLineChildReadback } from "./readback.js";

export interface TrafficLineApiOptions {
  maxSegmentPolls?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: Date;
  stableReadbackIntervalMs?: number;
  stableReadbackSamples?: number;
  itinerary?: readonly { spots?: Array<{ city?: string | null }> }[];
  endpointPlan?: TrafficLineEndpointPlan;
  rejectedTrainStationCodes?: readonly string[];
  childProgress?: readonly TrafficLineChildProgress[];
  onEndpointPlan?: (plan: TrafficLineEndpointPlan) => void;
  onUnavailableVariants?: (reasons: Partial<Record<TrafficLineVariant, string>>) => void;
  onRejectedTrainStationCodes?: (codes: string[]) => void;
  onChildProgress?: (progress: TrafficLineChildProgress) => void;
  onStatus?: (message: string) => void;
  disambiguator?: TrafficLineStationDisambiguator;
  product?: Record<string, unknown>;
}

export interface TrafficLineApiResult {
  enabled: boolean;
  children: Array<{ variant: TrafficLineVariant; lineDescription: string; childProductId: string; verified: TrafficLineChildReadback }>;
  skipped?: Array<{ variant: TrafficLineVariant; lineDescription: string; reason: string }>;
}

export type {
  TrafficLineEndpointPlan,
  TrafficLineVariant,
  TrafficLineChildProgress,
  TrafficLineChildReadback,
  TrafficLineStationDisambiguator,
};