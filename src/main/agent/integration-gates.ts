import { createHash } from 'node:crypto';
import type { AgentApproval, AgentSnapshot, ProductDetail, ProductReadiness } from '../../shared/contracts.js';
import { productSchema, parseProduct } from '../automation/schema/schema.js';
import { draftPhasesFor } from '../automation/automation.main/automation.main.phases.js';
import type { AgentFinishContext, AgentFinishResult } from './types.js';

type Json = Record<string, unknown>;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
}
/** Generated vendor codes and platform binding metadata are not operator choices. */
export function agentProductVersion(product: ProductDetail): string {
  const parsed = productSchema.safeParse(product.product);
  const data = structuredClone(parsed.success ? parsed.data : product.product) as unknown as Json;
  if (data.basicInfo) delete (data.basicInfo as Json).supplierProductCode;
  const ops = data.operations as Json | undefined;
  const resource = ops?.hotelResource as Json | undefined;
  // When per-day verified candidates exist, the VBK resourceGroup ID is merely
  // the platform binding of that exact approved candidate set.
  const days = (Array.isArray(data.itinerary) ? data.itinerary : []) as Json[];
  if (resource && days.some(day=>Array.isArray(day.hotelCandidates) && day.hotelCandidates.length)) {
    const { resourceGroupId, resourceId, ...choices } = resource;
    ops!.hotelResource = choices;
  }
  return createHash('sha256').update(JSON.stringify(canonical(data))).digest('hex');
}
export function requiredAgentPhases(product: ProductDetail): string[] {
  const data = product.product as unknown as Parameters<typeof draftPhasesFor>[0];
  return [...(!product.productId ? ['saleControl'] : []), ...draftPhasesFor({...data,itinerary:Array.isArray(data.itinerary)?data.itinerary:[],sales:data.sales ?? {productForm:'privateTour'}})];
}
export function approvalForRun(snapshot?: AgentSnapshot): AgentApproval | undefined {
  return snapshot?.events.filter(e=>e.runId===snapshot.run?.id && e.type==='approval')
    .map(e=>e.data?.approval as AgentApproval | undefined).reverse().find(a=>a?.status==='approved');
}
export function buildAgentApproval(product: ProductDetail) {
  const data = product.product as Json;
  const basic = data.basicInfo as Json;
  const commercial = data.commercial as Json | undefined;
  const pricing = commercial?.pricing as Json | undefined;
  const inventory = commercial?.inventory as Json | undefined;
  return {
    scope: requiredAgentPhases(product).map(phase=>`vbk.write_phase:${phase}`),
    summary: `${basic.meetingCity || basic.destinationCity} · ${basic.days}天${basic.nights}晚。${pricing ? `成人 ¥${pricing.adult}，儿童 ¥${pricing.child}。` : ''}${inventory ? `班期 ${inventory.startDate} 至 ${inventory.endDate}。` : ''}请核对右侧行程、资源和条款，确认后录入当前方案。`,
  };
}
export function agentCompletionGate(product: ProductDetail, snapshot: AgentSnapshot | undefined, readiness: ProductReadiness, context?: AgentFinishContext): AgentFinishResult {
  if (!context?.hadRemoteWrites) {
    if (!readiness.ready) return {verified:false,message:`本地方案仍需完善：${readiness.issues.map(issue=>issue.label).join('、')}。请补齐或向用户询问。`};
    return {verified:false, finalApproval:buildAgentApproval(product)};
  }
  const approval = approvalForRun(snapshot);
  if (!approval || approval.intentVersion !== snapshot?.run?.intentVersion || approval.productVersion !== agentProductVersion(product)) return {verified:false,message:'当前方案与已确认版本不一致，请重新请求最终确认。'};
  const required = requiredAgentPhases(product).map(phase=>`vbk.write_phase:${phase}`);
  if (required.some(scope=>!approval.scope.includes(scope))) return {verified:false,message:'已确认范围不完整，请重新请求最终确认。'};
  const phases = approval.scope.filter(scope=>scope.startsWith('vbk.write_phase:')).map(scope=>scope.split(':')[1]);
  const evidence = snapshot?.events.filter(e=>e.runId===context.runId && e.type==='tool_result' && e.data?.verified===true && e.data?.approvalId===approval.id && e.data?.productId===product.productId) ?? [];
  const missing = phases.filter(phase=>!evidence.some(e=>e.data?.phase===phase));
  if (!phases.length || missing.length) return {verified:false,message:`本轮尚未完成已确认范围的回读：${missing.join('、') || '缺少录入范围'}。请继续对应阶段。`};
  return {verified:true};
}
