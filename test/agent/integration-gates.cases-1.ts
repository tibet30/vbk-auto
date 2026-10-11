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
    itinerary:[{...p.product.itinerary![0]!,description:'当晚按用户要求住江孜，酒店待运营匹配。',hotel:'江孜4钻酒店',hotelCandidates:candidates}],
    dailyCandidates:[{day:1,candidates}],searchDates:{checkin:'2026-12-01',checkout:'2026-12-02'},
  });
  assert.deepEqual((next.itinerary as any[])[0].hotelCandidates,candidates);
  assert.equal((next.itinerary as any[])[0].description,'当晚按用户要求住江孜，已匹配江孜4钻酒店。');
  assert.equal((next.operations as any).hotelResource.source,'ctrip');
  assert.deepEqual((next.operations as any).hotelResource.dailyCandidates,[{day:1,candidates}]);
  assert.deepEqual(persistedItineraryHotelResult({
    itinerary: next.itinerary, dailyCandidates: [{ day: 1, candidates }], searchDates: { checkin: '2026-12-01', checkout: '2026-12-02' },
  } as any), {
    persisted: true, persistedPath: 'itinerary[].hotelCandidates',
    persistenceNote: '酒店候选已自动写回本地行程，无需再调用 patch_product 更新 itinerary。',
    dailyCandidates: [{ day: 1, candidates }], searchDates: { checkin: '2026-12-01', checkout: '2026-12-02' },
    persistedDays: [{ day: 1, hotel: '江孜4钻酒店', candidateCount: 1, selectedHotel: { hotelId: 101, hotelName: '江孜4钻酒店', diamond: 4, cityName: '江孜' } }],
  });
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

test('resolved hotel copy replaces only the projector placeholder for a persisted selection',()=>{
  const candidate={hotelId:101,hotelName:'日喀则希尔顿酒店',diamond:5,score:4.8,distanceKm:1,cityName:'日喀则',anchorName:'市政府',anchorCityId:92};
  const day={day:1,hotel:'日喀则希尔顿酒店',hotelCandidates:[candidate],description:'当晚按用户要求住日喀则，酒店待运营匹配。'};
  assert.equal(reconcileResolvedHotelCopy(day).description,'当晚按用户要求住日喀则，已匹配日喀则希尔顿酒店。');
  assert.equal(reconcileResolvedHotelCopy({...day,hotel:'其他酒店'}).description,day.description);
  assert.equal(reconcileResolvedHotelCopy({...day,description:'运营已确认入住日喀则希尔顿酒店。'}).description,'运营已确认入住日喀则希尔顿酒店。');
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
  assert.deepEqual(itinerary[0].spots,[{name:'宽窄巷子',poiName:'宽窄巷子',poiId:123,kind:'attraction'}]);
  assert.deepEqual(itinerary[1].spots,[{name:'武侯祠',poiName:'武侯祠',poiId:456,kind:'attraction'}]);
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
test('itinerary patch may remove a user-named administrative location node',()=>{
  const p=product();
  (p.product.basicInfo as any).userIdea='D1 天峻县/天峻-茶卡盐湖';
  (p.product.itinerary as any)[0].spots=[
    {name:'天峻',poiId:null,poiName:null},
    {name:'茶卡盐湖',poiId:null,poiName:null},
  ];
  assert.doesNotThrow(
    ()=>agentPatchOperations(p,{itinerary:[{day:1,spots:[{name:'茶卡盐湖',poiId:null,poiName:null}]}]}),
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
test('deterministic automation rejects unexplained fingerprint drift mid-flight and on failed resume',()=>{
  const {p,snapshot,approval}=fixture();
  (p.product.basicInfo as any).subtitle='录入中敏感词改写后的文案';
  assert.notEqual(approval.productVersion,agentProductVersion(p));
  assert.throws(()=>assertAgentWriteAuthorized(p,snapshot,'saleControl','account'),/方案、意图或账号已变化/);
  p.automation={id:'agent:run',status:'failed',logs:[],phases:[{phase:'saleControl',status:'failed'}]} as any;
  assert.equal(isDeterministicAutomationInFlight(p,approval.intentVersion,snapshot.run!.intentVersion),true);
  assert.throws(()=>assertAgentWriteAuthorized(p,snapshot,'saleControl','account'),/方案、意图或账号已变化/);
  p.automation.status='running';
  assert.throws(()=>assertAgentWriteAuthorized(p,snapshot,'presentation','account'),/方案、意图或账号已变化/);
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

test('remote completion rejects a traffic child without final readback before preflight closes the mother product',()=>{
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
test('remote completion rejects missing configured traffic children even when the parent phases are completed',()=>{
  const p=enableTrafficLine(product());
  const approval={id:'a',...buildAgentApproval(p),accountKey:'account',productVersion:agentProductVersion(p),intentVersion:'intent',status:'approved' as const,createdAt:'2026-09-05'};
  const snapshot: AgentSnapshot={localProductId:p.id,run:{id:'r',status:'running',intentVersion:'intent',createdAt:'2026-09-05',updatedAt:'2026-09-05'},events:[{id:'e',runId:'r',type:'approval',content:'确认',createdAt:'2026-09-05',data:{approval}}]};
  p.productId='123';
  p.automation={status:'succeeded',phases:approval.scope.map(scope=>({phase:scope.split(':')[1],status:'completed'})),trafficLine:{children:[],failureReason:'net::ERR_FAILED'}} as any;
  snapshot.events.push(...approval.scope.map((scope,index)=>({id:`done${index}`,runId:'r',type:'tool_result' as const,content:'done',createdAt:'now',data:{verified:true,approvalId:approval.id,phase:scope.split(':')[1],productId:'123'}})));
  const result=agentCompletionGate(p,snapshot,ready,{runId:'r',hadWrites:true,hadRemoteWrites:true});
  assert.equal(result.verified,false);
  assert.match(result.message ?? '',/飞机套餐尚未创建/);
});
