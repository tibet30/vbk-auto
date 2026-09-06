import type { AgentSnapshot, ProductDetail } from '../../shared/contracts.js';
import { normaliseTrafficLineVariant, trafficLineLabel, type TrafficLineChildStage, type TrafficLineVariant } from '../../shared/contracts-traffic-line.js';
import { getProductBaseInfoApi } from '../automation/ctrip/basic-info/api.js';
import { getProductSegmentsApi, segmentsFromPayload } from '../automation/ctrip/vehicle-resource-api.js';
import { runProductPreflightApi } from '../automation/ctrip/preflight-api.js';
import { readTrafficLineChildren } from '../automation/ctrip/traffic-line/relationships.js';

interface TrafficLineCheckpoint {
  variant: TrafficLineVariant;
  productId: string;
  activated: boolean;
}
interface ReconciliationResult {
  reconciled: boolean;
  retryable?: boolean;
  message: string;
  phase?: string;
}

/** Reconciliation is deliberately read-only. A shell without an ID cannot be recreated safely. */
export async function reconcileAgentShell(product: ProductDetail, snapshot: AgentSnapshot, toolCallId: string, page: Parameters<typeof getProductBaseInfoApi>[0]): Promise<ReconciliationResult> {
  const call=snapshot.events.find(event=>event.type==='tool_call' && event.data?.toolCallId===toolCallId);
  const phase=(call?.data?.arguments as Record<string,unknown> | undefined)?.phase;
  if (!product.productId) return {reconciled:false,message:'产品创建结果不确定，尚无可核对的产品编号。请先在 VBK 产品库核查，避免重复创建。'};
  if (phase==='trafficLine') return reconcileTrafficLine(product, page);
  if (phase==='preflight') return reconcilePreflight(product, page);
  if (phase==='basic') return reconcileBasicInfo(product, page);
  if (phase==='hotelResource') return reconcileHotelResource(product, page, call?.data?.arguments, snapshot, toolCallId);
  if (phase!=='saleControl') return {reconciled:false,message:`${String(phase ?? '当前')}阶段的写入结果尚未核对。为避免重复操作已保留现场；请在 VBK 检查该阶段，当前版本不会自动重放不确定写入。`};
  const remote=await getProductBaseInfoApi(page,product.productId);
  const base=remote.baseInfo as Record<string,unknown> | undefined;
  const code=(product.product.basicInfo as Record<string,unknown>).supplierProductCode;
  if (String(base?.productId)!==String(product.productId) || !code || String(base?.vendorProductCode)!==String(code)) {
    return {reconciled:false,message:'远端产品编号或供应商编号与本地不一致，仍需核查。'};
  }
  return {reconciled:true,message:`已从 VBK 核对产品 ${product.productId} 的创建结果，不会重复创建。`,phase:'saleControl'};
}

async function reconcileHotelResource(product: ProductDetail, page: Parameters<typeof getProductBaseInfoApi>[0], _arguments: unknown, snapshot: AgentSnapshot, toolCallId: string) {
  const result = snapshot.events.find((event) => event.type === 'tool_result' && event.data?.toolCallId === toolCallId);
  const reason = String(result?.content ?? '');
  // 仅允许已知的本地布局校验失败恢复；它发生在酒店候选写入前，不能把它伪装成成功。
  if (!reason.includes('住宿资源行程段未按连续住宿城市拆分')) {
    return { reconciled: false, message: '酒店资源写入结果未能从只读证据确认，已保留现场。' };
  }
  const payload = await getProductSegmentsApi(page, product.productId!);
  const lodging = segmentsFromPayload(payload).filter((segment) => Number(segment.segmentBase?.stayNights) > 0);
  return {
    reconciled: false,
    retryable: true,
    message: `已只读核对到 ${lodging.length} 个住宿段；上一轮在写入候选前因旧布局校验停止，可用修复后的布局逻辑定向重试酒店阶段。`,
  };
}

async function reconcileBasicInfo(product: ProductDetail, page: Parameters<typeof getProductBaseInfoApi>[0]) {
  const remote = await getProductBaseInfoApi(page, product.productId!);
  const base = remote.baseInfo as Record<string, unknown> | undefined;
  const code = (product.product.basicInfo as Record<string, unknown>).supplierProductCode;
  if (String(base?.productId) !== String(product.productId) || !code || String(base?.vendorProductCode) !== String(code)) {
    return { reconciled: false, message: '基础信息远端产品编号或供应商编号与本地不一致，仍需核查。' };
  }
  return { reconciled: true, message: `已从 VBK 核对产品 ${product.productId} 的基础信息，已有保存结果不会重复提交。`, phase: 'basic' };
}

async function reconcilePreflight(product: ProductDetail, page: Parameters<typeof getProductBaseInfoApi>[0]) {
  try {
    const evidence = await runProductPreflightApi(page, product.product, product.productId!);
    return {
      reconciled: true,
      message: `已从 VBK 完成最终预检回读：产品 ${evidence.productId} 的基础信息、套餐、图文、行程、条款、价格库存与资源均已核实。`,
      phase: 'preflight',
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { reconciled: false, message: `最终预检的只读核对未通过：${reason}。已保留现场，不会重复写入。` };
  }
}

async function reconcileTrafficLine(product: ProductDetail, page: Parameters<typeof getProductBaseInfoApi>[0]) {
  const expected = trafficLineCheckpoints(product);
  if (!expected.length) {
    return { reconciled: false, message: '交通阶段没有可用于核对的子产品检查点，不能安全恢复。' };
  }
  const children = await readTrafficLineChildren(page, product.productId!);
  const results = expected.map((checkpoint) => {
    const remote = children.find((child) => child.productId === checkpoint.productId);
    if (!remote) return { checkpoint, reason: `未找到${trafficLineLabel(checkpoint.variant)}子产品 ${checkpoint.productId}` };
    if (remote.active === undefined) return { checkpoint, reason: `${trafficLineLabel(checkpoint.variant)}子产品的启用状态未能从 VBK 读回` };
    if (remote.active !== checkpoint.activated) return { checkpoint, reason: `${trafficLineLabel(checkpoint.variant)}子产品的启用状态与本地检查点不一致` };
    return { checkpoint };
  });
  const failed = results.find((result) => result.reason);
  if (failed?.reason) return { reconciled: false, message: `交通阶段远端核对未通过：${failed.reason}。为避免重复写入，已保留现场。` };
  const summary = results.map(({ checkpoint }) => `${trafficLineLabel(checkpoint.variant)}${checkpoint.activated ? '已启用' : '未启用'}`).join('；');
  return {
    reconciled: true,
    message: `已从 VBK 只读核对交通子产品：${summary}。将继续处理，不会重复提交已确认无可售资源的子产品。`,
    phase: 'trafficLine',
  };
}

function trafficLineCheckpoints(product: ProductDetail): TrafficLineCheckpoint[] {
  const children = product.automation?.trafficLine?.children ?? [];
  return children.flatMap((child) => {
    const variant = normaliseTrafficLineVariant(child.variant);
    const productId = child.childProductId?.trim();
    if (!variant || !productId) return [];
    const stages = new Set<TrafficLineChildStage>(child.completedStages);
    return [{ variant, productId, activated: stages.has('activated') }];
  });
}
