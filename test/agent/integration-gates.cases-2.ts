import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProductSnapshot } from '../../src/main/infrastructure/database/parts/product-draft.js';
import { agentProductVersion, agentCompletionGate, buildAgentApproval, recoverEquivalentApproval } from '../../src/main/agent/integration-gates.js';
import { assertAgentWriteAuthorized, agentApprovalScopeError, isDeterministicAutomationInFlight } from '../../src/main/agent/integration-guard.js';
import { agentPlannerContext } from '../../src/main/agent/integration-context.js';
import { agentPatchOperations } from '../../src/main/agent/integration-patch.js';
import { applyResolvedItineraryHotels, persistedItineraryHotelResult } from '../../src/main/agent/integration.js';
import { reconcileResolvedHotelCopy, recoverResolvedHotelCandidates } from '../../src/main/agent/hotel-candidate-recovery.js';
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

function enableTrafficLine(productDetail: ReturnType<typeof product>) {
  Object.assign(productDetail.product.operations as Record<string, unknown>, {
    trafficLine: { enabled: true, variants: ['flightRoundTrip'] },
  });
  return productDetail;
}

test('remote completion retains failed traffic children after mother preflight succeeds',()=>{
  const p=enableTrafficLine(product());
  const approval={id:'a',generateTrafficChildren:true,...buildAgentApproval(p),accountKey:'account',productVersion:agentProductVersion(p),intentVersion:'intent',status:'approved' as const,createdAt:'2026-09-05'};
  const snapshot: AgentSnapshot={localProductId:p.id,run:{id:'r',status:'running',intentVersion:'intent',createdAt:'2026-09-05',updatedAt:'2026-09-05'},events:[{id:'e',runId:'r',type:'approval',content:'确认',createdAt:'2026-09-05',data:{approval}}]};
  p.productId='123';
  p.automation={
    id:'auto',status:'failed',currentPhase:'trafficLine',logs:[],
    phases:[
      {phase:'basic',status:'completed'},
      {phase:'presentation',status:'completed'},
      {phase:'itinerary',status:'completed'},
      {phase:'package',status:'completed'},
      {phase:'pricingInventory',status:'completed'},
      {phase:'terms',status:'completed'},
      {phase:'trafficLine',status:'failed'},
      {phase:'preflight',status:'completed'},
    ],
    trafficLine:{children:[{variant:'flightRoundTrip',lineDescription:'飞机往返',childProductId:'456',completedStages:['planned','childCreated'],verified:false,failedStage:'clausesSaved'}]},
  } as any;
  snapshot.events.push(...approval.scope.filter(scope=>!scope.endsWith(':trafficLine')).map((scope,index)=>({id:`done${index}`,runId:'r',type:'tool_result' as const,content:'done',createdAt:'now',data:{verified:true,approvalId:approval.id,phase:scope.split(':')[1],productId:'123'}})));
  const result=agentCompletionGate(p,snapshot,ready,{runId:'r',hadWrites:true,hadRemoteWrites:true});
  assert.equal(result.verified,false);
  assert.match(result.message ?? "", /交通子产品 456 尚未完成最终回读/);
  const patch=agentWorkflowPatch(snapshot,p);
  assert.equal(patch.progress,90);
});
test('remote completion tolerates skipped unavailable train children',()=>{
  const p=enableTrafficLine(product());
  Object.assign(p.product.operations as Record<string, unknown>, {
    trafficLine: { enabled: true, variants: ['flightRoundTrip', 'trainRoundTrip'] },
  });
  const approval={id:'a',generateTrafficChildren:true,...buildAgentApproval(p),accountKey:'account',productVersion:agentProductVersion(p),intentVersion:'intent',status:'approved' as const,createdAt:'2026-09-05'};
  const snapshot: AgentSnapshot={localProductId:p.id,run:{id:'r',status:'running',intentVersion:'intent',createdAt:'2026-09-05',updatedAt:'2026-09-05'},events:[{id:'e',runId:'r',type:'approval',content:'确认',createdAt:'2026-09-05',data:{approval}}]};
  p.productId='123';
  p.automation={
    trafficLine:{children:[
      {variant:'flightRoundTrip',lineDescription:'飞机往返',childProductId:'456',completedStages:['planned','childCreated','activated','finalReadback'],verified:true},
      {variant:'trainRoundTrip',lineDescription:'火车往返',childProductId:'789',completedStages:['planned','childCreated','presentationCopied'],verified:false,skipped:true,failureReason:'子产品资源校验后没有任何可用的多出发城市（站点：日喀则/日喀则），未激活套餐。'},
    ]},
  } as any;
  snapshot.events.push(...approval.scope.map((scope,index)=>({id:`done${index}`,runId:'r',type:'tool_result' as const,content:'done',createdAt:'now',data:{verified:true,approvalId:approval.id,phase:scope.split(':')[1],productId:'123'}})));
  assert.equal(agentCompletionGate(p,snapshot,ready,{runId:'r',hadWrites:true,hadRemoteWrites:true}).verified,true);
});
test('deterministic completion requires a matching approved fingerprint as well as durable phases',()=>{
  const {p,snapshot,approval}=fixture();
  p.productId='123';
  p.basicInfoSaved=true;
  (p.product.basicInfo as any).subtitle='录入后敏感词改写文案';
  assert.notEqual(approval.productVersion,agentProductVersion(p));
  p.automation={
    id:'agent:deterministic',status:'succeeded',logs:[],
    phases:approval.scope.map(scope=>({phase:scope.split(':')[1],status:'completed'})),
  } as any;
  const blocked=agentCompletionGate(p,snapshot,ready,{runId:'r',hadWrites:true,hadRemoteWrites:true});
  assert.equal(blocked.verified,false);
  const allowed=agentCompletionGate(p,snapshot,ready,{
    runId:'r',hadWrites:true,hadRemoteWrites:true,deterministicWorkflow:true,
  });
  assert.equal(allowed.verified,false);
  approval.productVersion=agentProductVersion(p);
  assert.equal(agentCompletionGate(p,snapshot,ready,{runId:"r",hadWrites:true,hadRemoteWrites:true,deterministicWorkflow:true}).verified,true);
});
test('verified deterministic preflight closes stale sale-control and hotel labels without another write',()=>{
  const {p,snapshot,approval}=fixture();
  p.productId='123';
  const phases = approval.scope.filter(scope => scope.startsWith('vbk.write_phase:')).map((scope) => {
    const phase = scope.split(':')[1]!;
    // hotelResource may remain pending after a successful preflight readback.
    return { phase, status: phase === 'hotelResource' ? 'pending' : 'completed' };
  });
  if (!phases.some((item) => item.phase === 'preflight')) {
    phases.push({ phase: 'preflight', status: 'completed' });
  }
  p.automation={
    id:'agent:deterministic',status:'succeeded',logs:[],
    phases,
    recovery:{phases:{saleControl:{phase:'saleControl',state:'completed',attempts:[]}}},
  } as any;
  assert.equal(agentCompletionGate(p,snapshot,ready,{
    runId:'r',hadWrites:true,hadRemoteWrites:true,deterministicWorkflow:true,
  }).verified,true);
  // A non-whitelisted pending phase still blocks completion.
  const itinerary = phases.find((item) => item.phase === 'itinerary');
  assert.ok(itinerary);
  itinerary.status = 'pending';
  assert.equal(agentCompletionGate(p,snapshot,ready,{
    runId:'r',hadWrites:true,hadRemoteWrites:true,deterministicWorkflow:true,
  }).verified,false);
});
test('new automation run clears historical completion while retaining stable run progress on resume',()=>{
  const p=product(); const initial=prepareAgentAutomation(p,'old','saleControl');
  initial.phases.forEach(phase=>phase.status='completed');p.automation=initial;
  const next=prepareAgentAutomation(p,'new','saleControl');assert.ok(next.phases.every(phase=>phase.status==='pending'));
  p.automation=next;next.phases[0]!.status='completed';
  assert.equal(prepareAgentAutomation(p,'new','basic').phases[0]!.status,'completed');
});
test('failed agent phase recovery preserves already verified phases instead of restarting the product',()=>{
  const p=enableTrafficLine(product());
  p.automation={
    id:'agent:old',status:'failed',currentPhase:'trafficLine',logs:[],
    phases:[
      {phase:'basic',status:'completed'},
      {phase:'presentation',status:'completed'},
      {phase:'itinerary',status:'completed'},
      {phase:'package',status:'completed'},
      {phase:'trafficLine',status:'failed'},
      {phase:'preflight',status:'pending'},
    ],
  } as any;
  const next=prepareAgentAutomation(p,'new-approval','trafficLine');
  assert.equal(next.id,'agent:old');
  assert.deepEqual(next.phases.map(phase=>[phase.phase,phase.status]),[
    ['basic','completed'],['presentation','completed'],['itinerary','completed'],
    ['package','completed'],['trafficLine','failed'],['preflight','pending'],
  ]);
});
test('a new approval in the same agent run preserves phases before preflight even when the run is queued',()=>{
  const p=product();
  p.automation={
    id:'agent:agent-run-1:approval-old',status:'queued',currentPhase:'trafficLine',logs:[],
    phases:[
      {phase:'basic',status:'completed'},
      {phase:'presentation',status:'completed'},
      {phase:'itinerary',status:'completed'},
      {phase:'package',status:'completed'},
      {phase:'trafficLine',status:'completed'},
      {phase:'preflight',status:'pending'},
    ],
  } as any;
  const next=prepareAgentAutomation(p,'agent-run-1:approval-new','preflight');
  assert.equal(next.id,'agent:agent-run-1:approval-old');
  assert.deepEqual(next.phases.map(phase=>[phase.phase,phase.status]),[
    ['basic','completed'],['presentation','completed'],['itinerary','completed'],
    ['package','completed'],['trafficLine','completed'],['preflight','pending'],
  ]);
});
test('workflow projection shows a short waiting message instead of the full approval summary and reports failure instead of fake running',()=>{
  const {snapshot,approval}=fixture();snapshot.pendingApproval={...approval,status:'pending'};
  assert.equal(agentWorkflowPatch(snapshot).message,'方案已就绪，等待授权录入');
  snapshot.pendingApproval=undefined;snapshot.run!.status='failed';snapshot.run!.error='需要修复';
  assert.equal(agentWorkflowPatch(snapshot).status,'failed');assert.equal(agentWorkflowPatch(snapshot).message,'需要修复');
  assert.equal(agentWorkflowPatch(snapshot).progress,0);
});

test('workflow projection keeps planning progress moving before an approval scope exists',()=>{
  const p=product();
  const snapshot: AgentSnapshot={localProductId:p.id,run:{id:'r2',status:'running',createdAt:'2026-09-05',updatedAt:'2026-09-05'},events:[]};
  assert.equal(agentWorkflowPatch(snapshot).progress,5);
  const call=(id:string,stage:string)=>({id,runId:'r2',type:'tool_call' as const,content:'',createdAt:'2026-09-05',data:{toolCallId:id,name:'generate_product_module',arguments:{stage}}});
  const done=(id:string)=>({id:`${id}-result`,runId:'r2',type:'tool_result' as const,content:'{}',createdAt:'2026-09-05',data:{toolCallId:id}});
  const failed=(id:string)=>({id:`${id}-error`,runId:'r2',type:'tool_result' as const,content:'{}',createdAt:'2026-09-05',data:{toolCallId:id,error:'失败'}});
  snapshot.events=[call('c1','skeleton'),done('c1'),call('c2','itinerary'),failed('c2'),call('c3','itinerary'),done('c3')];
  assert.equal(agentWorkflowPatch(snapshot).progress,28);
  snapshot.run!.status='waiting_approval';
  snapshot.pendingApproval={id:'ap',productVersion:'v',accountKey:'a',scope:[],summary:'等待确认',status:'pending',createdAt:'2026-09-05'};
  assert.equal(agentWorkflowPatch(snapshot).progress,50);
});

test('workflow projection keeps planning progress when approved scope has no write phases yet',()=>{
  const {snapshot,approval,p}=fixture();
  snapshot.pendingApproval={...approval,status:'pending'};
  assert.equal(agentWorkflowPatch(snapshot).progress,50);
  snapshot.pendingApproval=undefined;
  const patch=agentWorkflowPatch(snapshot,p);
  assert.equal(patch.stage,'automation');
  assert.equal(patch.progress,50);
});

test('workflow projection counts deterministic automation phases into entry progress',()=>{
  const {snapshot,approval}=fixture();
  const p=product();p.productId='123';
  p.automation={id:'auto',status:'running',currentPhase:'presentation',logs:[],
    phases:[{phase:'saleControl',status:'completed'},{phase:'basic',status:'completed'},{phase:'presentation',status:'running'}]} as any;
  const patch=agentWorkflowPatch(snapshot,p);
  assert.equal(patch.stage,'automation');
  const writeScopes = approval.scope.filter(scope => scope.startsWith('vbk.write_phase:'));
  assert.equal(patch.progress,Math.min(99,Math.round(2/writeScopes.length*100)));
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

test('saved mother cannot hide a traffic network failure; confirmed unavailable resources can finish',()=>{
  const p=enableTrafficLine(product());const approval={id:'a',generateTrafficChildren:true,...buildAgentApproval(p),accountKey:'account',productVersion:agentProductVersion(p),intentVersion:'intent',status:'approved' as const,createdAt:'now'};
  const snapshot:AgentSnapshot={localProductId:p.id,run:{id:'r',status:'running',intentVersion:'intent',createdAt:'now',updatedAt:'now'},events:[{id:'a',runId:'r',type:'approval',content:'确认',createdAt:'now',data:{approval}}]};
  p.productId='123';p.status='draft_saved';p.basicInfoSaved=true;
  p.automation={status:'succeeded',phases:[...approval.scope.filter(scope=>!scope.endsWith(':trafficLine')).map(scope=>({phase:scope.split(':')[1],status:'completed'})),{phase:'trafficLine',status:'failed'}],trafficLine:{children:[],failureReason:'net::ERR_FAILED'}} as any;
  assert.equal(agentCompletionGate(p,snapshot,ready,{runId:'r',hadWrites:true,hadRemoteWrites:true,deterministicWorkflow:true}).verified,false);
  p.automation!.trafficLine!.failureReason='当前无可售资源';
  assert.equal(agentCompletionGate(p,snapshot,ready,{runId:'r',hadWrites:true,hadRemoteWrites:true,deterministicWorkflow:true}).verified,true);
  p.automation!.phases.find(item=>item.phase==='preflight')!.status='failed';
  assert.equal(agentCompletionGate(p,snapshot,ready,{runId:'r',hadWrites:true,hadRemoteWrites:true,deterministicWorkflow:true}).verified,false);
});
