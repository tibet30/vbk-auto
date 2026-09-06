import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProductSnapshot } from '../../src/main/infrastructure/database/parts/product-draft.js';
import { agentProductVersion, agentCompletionGate, buildAgentApproval } from '../../src/main/agent/integration-gates.js';
import { assertAgentWriteAuthorized, agentApprovalScopeError } from '../../src/main/agent/integration-guard.js';
import { agentPlannerContext } from '../../src/main/agent/integration-context.js';
import { agentPatchOperations } from '../../src/main/agent/integration-patch.js';
import { agentWorkflowPatch } from '../../src/main/agent/integration-workflow.js';
import { prepareAgentAutomation } from '../../src/main/automation/automation.main/automation.main.agent.js';
import { applyProductPatchSafe } from '../../src/main/operations/product-patch.js';
import type { AgentSnapshot, ProductReadiness } from '../../src/shared/contracts.js';

const product = () => {
  const p=buildProductSnapshot({destination:'成都',days:2,productForm:'privateTour'});
  Object.assign(p.product.basicInfo!,{subtitle:'成都旅行',province:'四川',operationNotes:'按约定行程安排'});
  Object.assign(p.product.operations!,{pickupCity:'成都'});
  Object.assign(p.product.commercial!,{packageName:'标准套餐'});
  p.product.itinerary=[1,2].map(day=>({day,title:'游览成都',spots:[],description:'游览',hotel:'',meals:''}));
  return p;
};
const ready = {ready:true,issues:[]} as unknown as ProductReadiness;
function fixture() {
  const p = product();
  const approval = {id:'a',...buildAgentApproval(p),accountKey:'account',productVersion:agentProductVersion(p),intentVersion:'intent',status:'approved' as const,createdAt:'2026-09-05'};
  const snapshot: AgentSnapshot = {localProductId:p.id,run:{id:'r',status:'running',intentVersion:'intent',createdAt:'2026-09-05',updatedAt:'2026-09-05'},events:[{id:'e',runId:'r',type:'approval',content:'确认',createdAt:'2026-09-05',data:{approval}}]};
  return {p,snapshot,approval};
}

test('runtime statuses and vendor code do not invalidate approved business fields',()=>{
  const p=product(); const version=agentProductVersion(p);
  p.productId='123'; p.status='draft_saved'; p.basicInfoSaved=true;
  (p.product.basicInfo as any).supplierProductCode='generated';
  assert.equal(agentProductVersion(p),version);
  (p.product.basicInfo as any).subtitle='用户要求的新版文案';
  assert.notEqual(agentProductVersion(p),version);
});
test('fingerprinting tolerates incomplete local drafts',()=>{
  const p=product(); p.product={basicInfo:{meetingCity:'成都'}};
  assert.equal(agentProductVersion(p),agentProductVersion(structuredClone(p)));
});
test('planner receives valid skeleton and later intent without changing persisted original idea',()=>{
  const p=product(); const original=JSON.stringify(p.product);
  const c=agentPlannerContext(p,'测试','model',[{role:'user',content:'第二天不要安排购物'}]);
  assert.equal(c.skeleton.destination,'成都'); assert.equal(c.skeleton.days,2);
  assert.match(String((c.currentProduct.basicInfo as any).userIdea),/不要安排购物/);
  assert.equal(JSON.stringify(p.product),original);
});
test('nested patch preserves unrelated siblings and cannot inject platform identities',()=>{
  const p=product();
  const ops=agentPatchOperations(p,{basicInfo:{subtitle:'新标题'}});
  assert.deepEqual(ops,[{op:'replace',path:'/basicInfo/subtitle',value:'新标题'}]);
  assert.throws(()=>agentPatchOperations(p,{operations:{vehicleResource:{resourceGroupId:123}}}),/身份/);
  assert.throws(()=>agentPatchOperations(p,{presentation:{cover:{imageId:999}}}),/核验/);
});
test('AI cannot invent a POI reference through itinerary replacement',()=>{
  const p=product();
  assert.throws(()=>agentPatchOperations(p,{itinerary:[{day:1,spots:[{name:'景点',poiId:999,poiName:'景点'}]}]}),/POI ID/);
});
test('partial itinerary patch keeps existing POIs and untouched days',()=>{
  const p=product();
  (p.product.itinerary as any)[0].spots=[{name:'宽窄巷子',poiName:'宽窄巷子',poiId:123}];
  (p.product.itinerary as any)[1].spots=[{name:'武侯祠',poiName:'武侯祠',poiId:456}];
  const operations=agentPatchOperations(p,{itinerary:[{day:1,hotel:'成都酒店'}]});
  const result=applyProductPatchSafe(p.product,operations);
  const itinerary=result.product.itinerary as any[];
  assert.equal(result.applied,true);
  assert.equal(itinerary.length,2);
  assert.equal(itinerary[0].hotel,'成都酒店');
  assert.deepEqual(itinerary[0].spots,[{name:'宽窄巷子',poiName:'宽窄巷子',poiId:123}]);
  assert.deepEqual(itinerary[1].spots,[{name:'武侯祠',poiName:'武侯祠',poiId:456}]);
});
test('partial itinerary patch cannot silently clear existing POIs',()=>{
  const p=product();
  (p.product.itinerary as any)[0].spots=[{name:'宽窄巷子',poiName:'宽窄巷子',poiId:123}];
  assert.throws(()=>agentPatchOperations(p,{itinerary:[{day:1,spots:[]}]}),/不能通过局部补丁清空/);
});
test('itinerary patch contract rejects nested day arrays before a model can replace the itinerary',()=>{
  const p=product();
  assert.throws(()=>agentPatchOperations(p,{itinerary:[[{day:1,spots:[]}]] as any}),/行程日期格式无效/);
});
test('itinerary patch rejects an item wrapper instead of accepting a divergent structure',()=>{
  const p=product();
  assert.throws(()=>agentPatchOperations(p,{itinerary:{item:[{day:1,spots:{item:[{name:'景点',poiId:null,poiName:null}]}}]}} as any),/行程必须是逐日列表/);
});
test('itinerary patch cannot remove a user-named unmatched POI',()=>{
  const p=product();
  (p.product.basicInfo as any).userIdea='D1 去宽窄巷子和武侯祠';
  (p.product.itinerary as any)[0].spots=[{name:'宽窄巷子',poiId:null,poiName:null},{name:'武侯祠',poiId:null,poiName:null}];
  assert.throws(()=>agentPatchOperations(p,{itinerary:[{day:1,spots:[{name:'武侯祠',poiId:null,poiName:null}]}]}),/用户点名景点.*宽窄巷子/);
});
test('final approval cannot shrink to only creating a product shell',()=>{
  const {p}=fixture();
  assert.match(agentApprovalScopeError(p,['vbk.write_phase:saleControl'])!,/完整/);
  assert.equal(agentApprovalScopeError(p,buildAgentApproval(p).scope),undefined);
});
test('dispatch rechecks pause, account, business version and new intent',()=>{
  const {p,snapshot}=fixture();
  assert.doesNotThrow(()=>assertAgentWriteAuthorized(p,snapshot,'saleControl','account'));
  assert.throws(()=>assertAgentWriteAuthorized(p,snapshot,'saleControl','other'),/账号/);
  snapshot.run!.status='paused'; assert.throws(()=>assertAgentWriteAuthorized(p,snapshot,'saleControl','account'),/状态/);
  snapshot.run!.status='running'; snapshot.run!.intentVersion='changed';
  assert.throws(()=>assertAgentWriteAuthorized(p,snapshot,'saleControl','account'),/意图/);
});
test('an approved scope tolerates phases superseded by a completed product shell',()=>{
  const {p,snapshot,approval}=fixture();
  p.productId='123';
  approval.scope.push('vbk.write_phase:hotelResource');
  assert.match(agentApprovalScopeError(p,approval.scope)!,/不支持/);
  assert.doesNotThrow(()=>assertAgentWriteAuthorized(p,snapshot,'presentation','account'));
  assert.throws(()=>assertAgentWriteAuthorized(p,snapshot,'hotelResource','account'),/不再是当前方案/);
  assert.throws(()=>assertAgentWriteAuthorized(p,snapshot,'saleControl','account'),/不再是当前方案/);
});
test('local planning requires final approval while stale saved draft cannot establish current completion',()=>{
  const {p,snapshot}=fixture(); p.productId='123';p.status='draft_saved';
  const result=agentCompletionGate(p,snapshot,ready,{runId:'r',hadWrites:true,hadRemoteWrites:false});
  assert.ok(result.finalApproval);assert.equal(result.verified,false);
  assert.equal(agentCompletionGate(p,snapshot,ready,{runId:'r',hadWrites:true,hadRemoteWrites:true}).verified,false);
});
test('remote completion requires every phase with same run and product identity',()=>{
  const {p,snapshot,approval}=fixture();p.productId='123';
  snapshot.events.push(...approval.scope.map((scope,index)=>({id:`done${index}`,runId:'old',type:'tool_result' as const,content:'done',createdAt:'now',data:{verified:true,approvalId:approval.id,phase:scope.split(':')[1],productId:'123'}})));
  const context={runId:'r',hadWrites:true,hadRemoteWrites:true};
  assert.equal(agentCompletionGate(p,snapshot,ready,context).verified,false);
  snapshot.events.slice(1).forEach(e=>e.runId='r');
  assert.equal(agentCompletionGate(p,snapshot,ready,context).verified,true);
  snapshot.run!.intentVersion='new';
  assert.equal(agentCompletionGate(p,snapshot,ready,context).verified,false);
  snapshot.run!.intentVersion='intent';
  snapshot.events[1]!.data!.approvalId='old-approval';
  assert.equal(agentCompletionGate(p,snapshot,ready,context).verified,false);
  snapshot.events[1]!.data!.approvalId=approval.id;
  snapshot.events[1]!.data!.productId='other';
  assert.equal(agentCompletionGate(p,snapshot,ready,context).verified,false);
});
test('new automation run clears historical completion while retaining stable run progress on resume',()=>{
  const p=product(); const initial=prepareAgentAutomation(p,'old','saleControl');
  initial.phases.forEach(phase=>phase.status='completed');p.automation=initial;
  const next=prepareAgentAutomation(p,'new','saleControl');assert.ok(next.phases.every(phase=>phase.status==='pending'));
  p.automation=next;next.phases[0]!.status='completed';
  assert.equal(prepareAgentAutomation(p,'new','basic').phases[0]!.status,'completed');
});
test('workflow projection preserves approval summary and reports failure instead of fake running',()=>{
  const {snapshot,approval}=fixture();snapshot.pendingApproval={...approval,status:'pending'};
  assert.equal(agentWorkflowPatch(snapshot).message,approval.summary);
  snapshot.pendingApproval=undefined;snapshot.run!.status='failed';snapshot.run!.error='需要修复';
  assert.equal(agentWorkflowPatch(snapshot).status,'failed');assert.equal(agentWorkflowPatch(snapshot).message,'需要修复');
  assert.equal(agentWorkflowPatch(snapshot).progress,0);
});

test('read_product exposes exact approval scope and actionable readiness without nesting old dialogue', async()=>{
  const {agentProductContext}=await import('../../src/main/agent/integration-context.js');
  const p=product();
  delete (p.product.commercial as any).packageName;
  p.messages=[{id:'old',role:'assistant',content:'OLD_DIALOGUE'.repeat(10000)}] as any;
  const context=agentProductContext(p);
  assert.ok(!context.readiness.issues.some(issue=>issue.label==='commercial.packageName'));
  assert.deepEqual(context.requiredApprovalScope,context.requiredPhases.map(phase=>`vbk.write_phase:${phase}`));
  assert.ok(!JSON.stringify(context).includes('OLD_DIALOGUE'));
});

test('bare scope aliases normalize without granting missing phases or accepting unknown scopes',async()=>{
  const {normalizeAgentApprovalScope}=await import('../../src/main/agent/integration-guard.js');
  const p=product();const full=buildAgentApproval(p).scope;
  assert.deepEqual(normalizeAgentApprovalScope(p,full.map(scope=>scope.split(':')[1]!)),full);
  assert.equal(agentApprovalScopeError(p,normalizeAgentApprovalScope(p,full)),undefined);
  assert.match(agentApprovalScopeError(p,normalizeAgentApprovalScope(p,['basic']))!,/requiredApprovalScope/);
  assert.match(agentApprovalScopeError(p,normalizeAgentApprovalScope(p,[...full,'delete_everything']))!,/不支持/);
});

test('provider reasoning blocks are excluded from public answers',async()=>{
  const {stripAgentReasoning}=await import('../../src/shared/agent-visible-text.js');
  assert.equal(stripAgentReasoning('<think>internal analysis</think>\n请补充套餐名称。'),'请补充套餐名称。');
  assert.equal(stripAgentReasoning('<think>unfinished'),'');
  assert.equal(stripAgentReasoning('正常回答'),'正常回答');
});
