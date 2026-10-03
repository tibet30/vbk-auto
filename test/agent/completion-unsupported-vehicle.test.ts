import assert from 'node:assert/strict';
import test from 'node:test';
import {buildProductSnapshot} from '../../src/main/infrastructure/database/parts/product-draft.js';
import {agentCompletionGate, agentProductVersion, buildAgentApproval} from '../../src/main/agent/integration-gates.js';

test('平台禁止的历史用车授权只在完整远端预检通过后不再阻塞 Agent 结案', () => {
  for (const productForm of ['groupTour', 'semiSelfGuided'] as const) {
    const p=buildProductSnapshot({destination: '汕头', days: 5, productForm});
    p.productId='79229069'; p.basicInfoSaved=true;
    const approval={id:'a', ...buildAgentApproval(p), productVersion:agentProductVersion(p),
      intentVersion:'intent', status:'approved', scope:[...buildAgentApproval(p).scope, 'vbk.write_phase:vehicleResource']};
    const snapshot:any={localProductId:p.id, run:{id:'r', intentVersion:'intent'}, events:[
      {runId:'r', type:'approval', data:{approval}}]};
    p.automation={id:'auto', status:'succeeded', logs:[], phases:buildAgentApproval(p).scope.map(scope=>
      ({phase:scope.split(':')[1], status:'completed'}))} as any;
    const context={runId:'r', hadWrites:true, hadRemoteWrites:true, deterministicWorkflow:true};
    assert.equal(agentCompletionGate(p,snapshot,{ready:true, issues:[]} as any,context).verified,true);
    p.automation!.phases.find(item=>item.phase==='preflight')!.status='pending';
    assert.equal(agentCompletionGate(p,snapshot,{ready:true, issues:[]} as any,context).verified,false);
  }
});

test('已完成的远端草稿恢复时不再次进入任何写入阶段', async () => {
  const {DraftAutomation}=await import('../../src/main/automation/automation.main/automation.main.class.js');
  const p=buildProductSnapshot({destination:'汕头', days:5, productForm:'groupTour'});
  p.productId='79229069';
  Object.assign(p.product.basicInfo!, {subtitle:'潮汕旅行', province:'广东', operationNotes:'按约定行程安排'});
  Object.assign(p.product.operations!, {pickupCity:'汕头'});
  p.product.itinerary=Array.from({length:5}, (_, index)=>({day:index+1,title:'汕头游览',spots:[],description:'游览',hotel:'',meals:''}));
  const scopes=buildAgentApproval(p).scope;
  p.automation={id:'auto', status:'succeeded', logs:[], phases:scopes.map(scope=>
    ({phase:scope.split(':')[1], status:'completed'}))} as any;
  const mock:any={db:{getProduct:()=>p, getAgentSnapshot:()=>({run:{id:'r'},events:[
    {runId:'r',type:'approval',data:{approval:{status:'approved',scope:scopes}}}]})},
    agentWriteGuard:()=>{}, runApprovedLocked:()=>{throw new Error('不得重写');},
    runOnePhaseLocked:()=>{throw new Error('不得重写');}};
  await DraftAutomation.prototype.executeApprovedWorkflow.call(mock,p.id);
});
