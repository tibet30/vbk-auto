import { createHash } from 'node:crypto';
import type { AgentApproval, AgentSnapshot, ProductDetail, ProductReadiness } from '../../shared/contracts.js';
import { productSchema, parseProduct } from '../automation/schema/schema.js';
import { draftPhasesFor } from '../automation/automation.main/automation.main.phases.js';
import type { AgentFinishContext, AgentFinishResult } from './types.js';
import { preservesApprovedIntent } from './approval-intent.js';
import { trafficLineChildShouldBeSkipped } from '../automation/ctrip/traffic-line/main.js';
import { evaluatePreparationCompletion } from '../planning/preparation-completion.js';

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
  // The itinerary owns the approved per-day hotel choices. hotelResource is a
  // derived mirror written after the platform phase succeeds (source, selected
  // name, tier, candidates, segment ids, and other readback metadata). Keeping
  // that mirror in the fingerprint invalidates the approval immediately after
  // a successful hotelResource write even though no operator choice changed.
  const days = (Array.isArray(data.itinerary) ? data.itinerary : []) as Json[];
  if (resource && days.some(day=>Array.isArray(day.hotelCandidates) && day.hotelCandidates.length)) {
    // Keep the operator's effective hotel choice (source, resource ID/name,
    // room type, query and tier) in the approval fingerprint. Only strip
    // readback/candidate mirrors that are populated by the platform phase.
    const candidates = days.flatMap(day => Array.isArray(day.hotelCandidates) ? day.hotelCandidates as Json[] : []);
    // Only treat hotelResource as a pure platform mirror when the selected
    // name matches an itinerary candidate. Diamond alone is too weak: a
    // different property at the same tier must remain fingerprinted.
    const selectedFromItinerary = candidates.some(candidate => candidate.hotelName === resource.resourceName);
    if (selectedFromItinerary && !resource.query && !resource.roomType) {
      // A resource generated from the approved daily candidates has no extra
      // operator decision. Ignore its whole platform mirror, while an explicit
      // query/room-type selection remains fingerprinted.
      delete ops!.hotelResource;
    } else {
      delete resource.candidates;
      delete resource.dailyCandidates;
      delete resource.resourceId;
      delete resource.supplierCode;
    }
  }
  // Once daily hotel candidates exist, the candidate set is the resource
  // choice. Hotel resolution may later replace the generic display label and
  // description with the first candidate without changing anything submitted
  // to VBK. These derived strings must not invalidate the final approval.
  for (const day of days) {
    if (!Array.isArray(day.hotelCandidates) || !day.hotelCandidates.length) continue;
    delete day.hotel;
    delete day.hotelDescription;
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

/**
 * Upgrade an older approval after fingerprint normalization only when the
 * product still matches the last product read before approval and every later
 * user message is an explicit recovery-only instruction.
 */
export function recoverEquivalentApproval(product: ProductDetail, snapshot: AgentSnapshot): AgentApproval | undefined {
  const approval = approvalForRun(snapshot);
  if (!approval || !snapshot.run) return undefined;
  const approvalIndex = snapshot.events.findIndex((event) => event.type === 'approval'
    && (event.data?.approval as AgentApproval | undefined)?.id === approval.id);
  if (approvalIndex < 0) return undefined;
  const laterUserEvents = snapshot.events.slice(approvalIndex + 1).filter((event) => event.type === 'user');
  if (laterUserEvents.some((event) => !preservesApprovedIntent(event.content))) return undefined;
  for (let index = approvalIndex - 1; index >= 0; index -= 1) {
    const event = snapshot.events[index]!;
    if (event.type !== 'tool_result' || !event.content.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(event.content) as { id?: string; name?: string; status?: string; product?: unknown };
      if (!parsed.product || parsed.id !== product.id) continue;
      const approvedProduct = {
        ...product,
        product: parsed.product as ProductDetail['product'],
      };
      const currentVersion = agentProductVersion(product);
      if (agentProductVersion(approvedProduct) !== currentVersion) return undefined;
      return { ...approval, productVersion: currentVersion, intentVersion: snapshot.run.intentVersion };
    } catch {
      continue;
    }
  }
  return undefined;
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
    const evaluation = evaluatePreparationCompletion(product, snapshot);
    if (!evaluation.ready) {
      return {
        verified: false,
        message: `本地方案仍需完善：当前阶段 ${evaluation.currentStage}/${evaluation.currentNode}，${evaluation.missing.join('、') || evaluation.blockingReasons.join('、')}。请补齐或向用户询问。`,
      };
    }
    if (!readiness.ready) return {verified:false,message:`本地方案仍需完善：${readiness.issues.map(issue=>issue.label).join('、')}。请补齐或向用户询问。`};
    return {verified:false, finalApproval:buildAgentApproval(product)};
  }
  const approval = approvalForRun(snapshot);
  if (!approval || approval.intentVersion !== snapshot?.run?.intentVersion) {
    return {verified:false,message:'当前方案与已确认版本不一致，请重新请求最终确认。'};
  }
  const currentVersion = agentProductVersion(product);
  const automationSucceeded = product.automation?.status === 'succeeded';
  // Deterministic handoff may rewrite presentation/resources after approval.
  // Tolerate fingerprint drift only when the durable automation run succeeded.
  if (approval.productVersion !== currentVersion
    && !(context.deterministicWorkflow && automationSucceeded)) {
    return {verified:false,message:'当前方案与已确认版本不一致，请重新请求最终确认。'};
  }
  const required = requiredAgentPhases(product).map(phase=>`vbk.write_phase:${phase}`);
  if (required.some(scope=>!approval.scope.includes(scope))) return {verified:false,message:'已确认范围不完整，请重新请求最终确认。'};
  const phases = approval.scope.filter(scope=>scope.startsWith('vbk.write_phase:')).map(scope=>scope.split(':')[1]);
  const incompleteTrafficChild = phases.includes('trafficLine')
    ? product.automation?.trafficLine?.children.find((child) => {
      // Platform "no sellable resource" skips are durable success for that variant.
      if (trafficLineChildShouldBeSkipped(child)) return false;
      return !child.verified || !child.completedStages.includes('finalReadback');
    })
    : undefined;
  if (incompleteTrafficChild) {
    return {
      verified:false,
      message:`交通子产品 ${incompleteTrafficChild.childProductId ?? incompleteTrafficChild.lineDescription} 尚未完成最终回读，不能结束任务。请从 ${incompleteTrafficChild.failedStage ?? 'trafficLine'} 阶段继续。`,
    };
  }
  const evidence = snapshot?.events.filter(e=>e.runId===context.runId && e.type==='tool_result' && e.data?.verified===true && e.data?.approvalId===approval.id && e.data?.productId===product.productId) ?? [];
  // Older interrupted deterministic runs can retain a pending hotelResource
  // label (or omit saleControl from phases) even after a successful preflight
  // readback. Whitelist only those historically stale labels — never waive
  // every approved phase just because preflight completed.
  const staleDeterministicPhaseLabels = new Set(['hotelResource', 'saleControl']);
  const verifiedDeterministicPreflight = Boolean(
    context.deterministicWorkflow
      && automationSucceeded
      && product.automation?.phases.some((item) => item.phase === 'preflight' && item.status === 'completed'),
  );
  const missing = phases.filter(phase=>{
    if (evidence.some(e=>e.data?.phase===phase)) return false;
    if (verifiedDeterministicPreflight && staleDeterministicPhaseLabels.has(phase)) return false;
    // basicInfoSaved 只会在基础信息写入并完成远端回读后落库；恢复任务也会
    // 把对应 automation phase 保持为 completed。两项同时成立时，这是当前
    // 产品壳的耐久证据，不应为凑齐“本轮事件”再次改写基础信息。
    if (phase === 'basic'
      && product.basicInfoSaved === true
      && product.automation?.phases.some(item=>item.phase==='basic' && item.status==='completed')) {
      return false;
    }
    // Deterministic runner evidence lives on automation.phases, not agent tool_result events.
    if (context.deterministicWorkflow && automationSucceeded
      && product.automation?.phases.some(item=>item.phase===phase && item.status==='completed')) {
      return false;
    }
    return true;
  });
  if (!phases.length || missing.length) return {verified:false,message:`本轮尚未完成已确认范围的回读：${missing.join('、') || '缺少录入范围'}。请继续对应阶段。`};
  return {verified:true};
}
