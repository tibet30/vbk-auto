import type { TrafficLineConfig, TrafficLineVariant } from "../../../../shared/contracts-traffic-line.js";

export type { TrafficLineConfig, TrafficLineVariant };

export interface TrafficLineExistingChild {
  productId: string;
  lineDescription: string;
  packageId?: string;
  active?: boolean;
}

export interface TrafficLineTarget {
  variant: TrafficLineVariant;
  lineDescription: string;
}

export type TrafficLineChildAction =
  | { kind: "create"; target: TrafficLineTarget }
  | { kind: "reuse"; target: TrafficLineTarget; child: TrafficLineExistingChild }
  | { kind: "blocked"; target: TrafficLineTarget; reason: string };

export interface TrafficLineProvisionPlan {
  enabled: boolean;
  actions: TrafficLineChildAction[];
}

/** `getPackageProductDetail` 中创建子产品所需的母产品模板字段。 */
export interface TrafficLineCreateTemplate {
  generalInfoDto: Record<string, unknown>;
  subLineInfoDto: Record<string, unknown>;
}

export interface TrafficLineSaveRequest {
  parentProductId: string;
  lineDescription: string;
  generalInfoDto: Record<string, unknown>;
  subLineInfoDto: Record<string, unknown>;
}

export interface TrafficLineGateway {
  listExistingChildren(parentProductId: string): Promise<TrafficLineExistingChild[]>;
  getCreateTemplate(parentProductId: string): Promise<TrafficLineCreateTemplate>;
  createChild(request: TrafficLineSaveRequest): Promise<{ productId: string }>;
}

export interface TrafficLineProvisionResult {
  plan: TrafficLineProvisionPlan;
  created: TrafficLineExistingChild[];
  reused: TrafficLineExistingChild[];
  blocked: Array<{ target: TrafficLineTarget; reason: string }>;
}
