import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProductSnapshot } from '../../src/main/infrastructure/database/parts/product-draft.js';
import { agentProductVersion, agentCompletionGate, buildAgentApproval, recoverEquivalentApproval } from '../../src/main/agent/integration-gates.js';
import { assertAgentWriteAuthorized, agentApprovalScopeError, isDeterministicAutomationInFlight } from '../../src/main/agent/integration-guard.js';
import { agentPlannerContext } from '../../src/main/agent/integration-context.js';
import { agentPatchOperations } from '../../src/main/agent/integration-patch.js';
import { applyResolvedItineraryHotels } from '../../src/main/agent/integration.js';
import { recoverResolvedHotelCandidates } from '../../src/main/agent/hotel-candidate-recovery.js';
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
test('platform hotel readback mirror does not invalidate approved itinerary hotel choices',()=>{
  const p=product();
  (p.product.itinerary as any)[0].hotel='成都酒店';
  (p.product.itinerary as any)[0].hotelCandidates=[
    {hotelId:101,hotelName:'成都酒店',diamond:4,cityName:'成都'},
  ];
  const version=agentProductVersion(p);
  (p.product.operations as any).hotelResource={
    source:'ctrip',resourceName:'成都酒店',hotelTier:'当地4钻酒店/-4',diamond:4,
    candidates:(p.product.itinerary as any)[0].hotelCandidates,
    dailyCandidates:[{day:1,candidates:(p.product.itinerary as any)[0].hotelCandidates}],
    segmentIds:['segment-1'],
  };
  assert.equal(agentProductVersion(p),version);
  (p.product.itinerary as any)[0].hotelCandidates[0].hotelId=202;
  assert.notEqual(agentProductVersion(p),version);
});

test('resolved hotel display text does not invalidate an unchanged approved candidate set',()=>{
  const p=product();
  p.product.itinerary=[{
    day:1,
    title:'成都住宿',
    description:'入住当地酒店',
    hotel:'当地4钻酒店',
    hotelDescription:'当地4钻酒店；候选五家',
    spots:[],
    hotelCandidates:[
      {hotelId:101,hotelName:'成都酒店',diamond:4,score:4.8,distanceKm:1,cityName:'成都',anchorName:'景点',anchorCityId:28},
    ],
  }];
  const version=agentProductVersion(p);
  p.product.itinerary[0]!.hotel='成都酒店';
  p.product.itinerary[0]!.hotelDescription='优先入住成都酒店';
  assert.equal(agentProductVersion(p),version);
  p.product.itinerary[0]!.hotelCandidates![0]!.hotelId=102;
  assert.notEqual(agentProductVersion(p),version);
});

test('resolved hotels persist both the daily candidates and controlled Ctrip resource source',()=>{
  const p=product();
  const candidates=[{hotelId:101,hotelName:'江孜4钻酒店',diamond:4,score:4.8,distanceKm:1.2,cityName:'江孜',anchorName:'白居寺',anchorCityId:20859}];
  const next=applyResolvedItineraryHotels(p.product as any,{
    itinerary:[{...p.product.itinerary![0]!,hotel:'江孜4钻酒店',hotelCandidates:candidates}],
    dailyCandidates:[{day:1,candidates}],searchDates:{checkin:'2026-12-01',checkout:'2026-12-02'},
  });
  assert.deepEqual((next.itinerary as any[])[0].hotelCandidates,candidates);
  assert.equal((next.operations as any).hotelResource.source,'ctrip');
  assert.deepEqual((next.operations as any).hotelResource.dailyCandidates,[{day:1,candidates}]);
});

test('hotel recovery restores only a matching durable resolver result',()=>{
  const p=product();
  (p.product.itinerary as any)[0].hotel='江孜4钻酒店';
  const candidates=[{hotelId:101,hotelName:'江孜4钻酒店',diamond:4,score:4.8,distanceKm:1.2,cityName:'江孜',anchorName:'白居寺',anchorCityId:20859}];
  const snapshot={events:[
    {type:'tool_call',data:{name:'resolve_itinerary_hotels',toolCallId:'hotel-call'}},
    {type:'tool_result',data:{toolCallId:'hotel-call'},content:JSON.stringify({dailyCandidates:[{day:1,candidates}]})},
  ]} as any;
  const restored=recoverResolvedHotelCandidates(p.product as any,snapshot)!;
  assert.deepEqual((restored.itinerary as any[])[0].hotelCandidates,candidates);
  assert.equal((restored.operations as any).hotelResource.source,'ctrip');
  (p.product.itinerary as any)[0].hotel='用户改过的酒店';
  assert.equal(recoverResolvedHotelCandidates(p.product as any,snapshot),null);
});

test('recovery-only messages migrate an older equivalent approval without a second prompt',()=>{
  const {p,snapshot,approval}=fixture();
  p.product.itinerary=[{
    day:1,title:'成都住宿',description:'入住当地酒店',hotel:'当地4钻酒店',hotelDescription:'候选五家',spots:[],
    hotelCandidates:[{hotelId:101,hotelName:'成都酒店',diamond:4,score:4.8,distanceKm:1,cityName:'成都',anchorName:'景点',anchorCityId:28}],
  }];
  const approvedProduct=structuredClone(p.product);
  approval.productVersion='legacy-version';
  snapshot.events.unshift({id:'read',runId:'r',type:'tool_result',content:JSON.stringify({id:p.id,product:approvedProduct}),createdAt:'before'});
  snapshot.run!.intentVersion='recovery-intent';
  snapshot.events.push({id:'user',runId:'r',type:'user',content:'从报错处继续执行',createdAt:'after'});
  p.product.itinerary[0]!.hotel='成都酒店';
  p.product.itinerary[0]!.hotelDescription='优先入住成都酒店';
  const recovered=recoverEquivalentApproval(p,snapshot);
  assert.equal(recovered?.id,approval.id);
  assert.equal(recovered?.productVersion,agentProductVersion(p));
  assert.equal(recovered?.intentVersion,'recovery-intent');
  snapshot.events.push({id:'change',runId:'r',type:'user',content:'把成人价改成 1880',createdAt:'later'});
  assert.equal(recoverEquivalentApproval(p,snapshot),undefined);
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
  assert.deepEqual(agentPatchOperations(p,{operations:{trafficLine:{arrivalCity:'拉萨',departureCity:'西安'}}}),[
    {op:'replace',path:'/operations/trafficLine/arrivalCity',value:'拉萨'},
    {op:'replace',path:'/operations/trafficLine/departureCity',value:'西安'},
  ]);
  assert.throws(()=>agentPatchOperations(p,{operations:{trafficLine:{variants:['flightRoundTrip']}}}),/必须由接口核验/);
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
  assert.throws(
    ()=>agentPatchOperations(p,{itinerary:[{day:1,spots:[{name:'武侯祠',poiId:null,poiName:null}]}]}),
    /已锁定的第 1 天景点必须保留.*宽窄巷子/,
  );
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
test('deterministic automation tolerates product fingerprint drift mid-flight and on failed resume',()=>{
  const {p,snapshot,approval}=fixture();
  (p.product.basicInfo as any).subtitle='录入中敏感词改写后的文案';
  assert.notEqual(approval.productVersion,agentProductVersion(p));
  assert.throws(()=>assertAgentWriteAuthorized(p,snapshot,'saleControl','account'),/方案、意图或账号已变化/);
  p.automation={id:'agent:run',status:'failed',logs:[],phases:[{phase:'saleControl',status:'failed'}]} as any;
  assert.equal(isDeterministicAutomationInFlight(p,approval.intentVersion,snapshot.run!.intentVersion),true);
  assert.doesNotThrow(()=>assertAgentWriteAuthorized(p,snapshot,'saleControl','account'));
  p.automation.status='running';
  assert.doesNotThrow(()=>assertAgentWriteAuthorized(p,snapshot,'presentation','account'));
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
test('remote completion reuses verified durable basic info without rewriting it in a recovery run',()=>{
  const {p,snapshot,approval}=fixture();p.productId='123';p.basicInfoSaved=true;
  p.automation={
    id:'agent:recovery',status:'succeeded',logs:[],
    phases:buildAgentApproval(p).scope.map(scope=>({phase:scope.split(':')[1],status:'completed'})),
  } as any;
  const nonBasic=approval.scope.filter(scope=>!scope.endsWith(':basic'));
  snapshot.events.push(...nonBasic.map((scope,index)=>({
    id:`done${index}`,runId:'r',type:'tool_result' as const,content:'done',createdAt:'now',
    data:{verified:true,approvalId:approval.id,phase:scope.split(':')[1],productId:'123'},
  })));
  assert.equal(agentCompletionGate(p,snapshot,ready,{runId:'r',hadWrites:true,hadRemoteWrites:true}).verified,true);
  p.automation.phases.find(phase=>phase.phase==='basic')!.status='pending';
  assert.equal(agentCompletionGate(p,snapshot,ready,{runId:'r',hadWrites:true,hadRemoteWrites:true}).verified,false);
});
function enableTrafficLine(productDetail: ReturnType<typeof product>) {
  Object.assign(productDetail.product.operations as Record<string, unknown>, {
    trafficLine: { enabled: true, variants: ['flightRoundTrip'] },
  });
  return productDetail;
}

test('remote completion rejects a traffic child without final readback',()=>{
  const p=enableTrafficLine(product());
  const approval={id:'a',...buildAgentApproval(p),accountKey:'account',productVersion:agentProductVersion(p),intentVersion:'intent',status:'approved' as const,createdAt:'2026-09-05'};
  const snapshot: AgentSnapshot={localProductId:p.id,run:{id:'r',status:'running',intentVersion:'intent',createdAt:'2026-09-05',updatedAt:'2026-09-05'},events:[{id:'e',runId:'r',type:'approval',content:'确认',createdAt:'2026-09-05',data:{approval}}]};
  p.productId='123';
  p.automation={trafficLine:{children:[{variant:'flightRoundTrip',lineDescription:'飞机往返',childProductId:'456',completedStages:['planned','childCreated'],verified:false,failedStage:'clausesSaved'}]}} as any;
  snapshot.events.push(...approval.scope.map((scope,index)=>({id:`done${index}`,runId:'r',type:'tool_result' as const,content:'done',createdAt:'now',data:{verified:true,approvalId:approval.id,phase:scope.split(':')[1],productId:'123'}})));
  const result=agentCompletionGate(p,snapshot,ready,{runId:'r',hadWrites:true,hadRemoteWrites:true});
  assert.equal(result.verified,false);
  assert.match(result.message ?? '',/交通子产品 456 尚未完成最终回读/);
});
test('remote completion tolerates skipped unavailable train children',()=>{
  const p=enableTrafficLine(product());
  Object.assign(p.product.operations as Record<string, unknown>, {
    trafficLine: { enabled: true, variants: ['flightRoundTrip', 'trainRoundTrip'] },
  });
  const approval={id:'a',...buildAgentApproval(p),accountKey:'account',productVersion:agentProductVersion(p),intentVersion:'intent',status:'approved' as const,createdAt:'2026-09-05'};
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
test('deterministic handoff completion accepts durable automation phases after fingerprint drift',()=>{
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
  assert.equal(allowed.verified,true);
});
test('verified deterministic preflight closes stale sale-control and hotel labels without another write',()=>{
  const {p,snapshot,approval}=fixture();
  p.productId='123';
  const phases = approval.scope.map((scope) => {
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
  assert.equal(patch.progress,Math.min(99,Math.round(2/approval.scope.length*100)));
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
