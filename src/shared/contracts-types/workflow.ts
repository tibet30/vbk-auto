/**
 * 一键创建后台任务的持久化形态：独立于 renderer 生命周期，以产品为跳转主体。
 */

export type ProductWorkflowTaskStatus =
  | "queued"
  | "running"
  | "needs_attention"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "abandoned";

export type ProductWorkflowTaskStage =
  | "queued"
  | "planning"
  | "readiness"
  | "automation"
  | "completed";

export interface ProductWorkflowTask {
  id: string;
  localProductId: string;
  productName: string;
  status: ProductWorkflowTaskStatus;
  stage: ProductWorkflowTaskStage;
  progress: number;
  message: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}