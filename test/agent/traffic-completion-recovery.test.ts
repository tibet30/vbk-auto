import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentCore } from '../../src/main/agent/core.js';
import type { AgentSnapshot } from '../../src/shared/contracts.js';

test('a completed parent is retained even when optional traffic failed',async()=>{
  let snapshot:AgentSnapshot={localProductId:'p',run:{id:'r',status:'completed',intentVersion:'intent',createdAt:'now',updatedAt:'now'},events:[{id:'write',runId:'r',type:'tool_result',content:'parent saved',createdAt:'now',data:{verified:true,productId:'123',changedSections:['basic']}}]};
  let handoffs=0;
  const product:any={productId:'123',product:{operations:{trafficLine:{enabled:true,variants:['flightRoundTrip','trainRoundTrip']}}},automation:{status:'succeeded',phases:[{phase:'basic',status:'completed'},{phase:'trafficLine',status:'completed'}],trafficLine:{children:[],failureReason:'net::ERR_FAILED'}}};
  const core=new AgentCore({model:{complete:async()=>{throw new Error('read must not start work');}},tools:[],accountFor:async()=>({accountKey:'a',productVersion:'v'}),preparationProduct:()=>product,handoffApprovedWorkflow:()=>{handoffs++;return true;}},{getAgentSnapshot:()=>structuredClone(snapshot),saveAgentSnapshot:s=>{snapshot=structuredClone(s);}});
  assert.equal((await core.get('p')).run?.status,'completed');assert.equal(handoffs,0);
  assert.equal(snapshot.run?.error,undefined);
});
