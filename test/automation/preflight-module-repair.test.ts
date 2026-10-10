import test from 'node:test';
import assert from 'node:assert/strict';
import {preflightRepairPhase} from '../../src/main/automation/automation.main/preflight-repair-phase.js';
import {prepareAutomationResumeRun} from '../../src/main/automation/automation.main/automation.main.resume-state.js';
import type {AutomationRun} from '../../src/shared/contracts.js';
test('precise preflight mismatches reopen the affected module and dependent readback gates',()=>{
 for(const [error,phase] of [['产品图文预检推荐理由不一致：缺少「当前理由」','presentation'],['酒店资源只读回读住宿段数量不一致：期望 1，实际 0','hotelResource'],['酒店资源只读回读第 1 段候选 ID 集合不一致：期望=123,456，实际=','hotelResource']]){
 assert.equal(preflightRepairPhase(error),phase);
 const phases=['basic','presentation','hotelResource','trafficLine','preflight'];
 const old={id:'r',status:'failed',currentPhase:'preflight',logs:[],phases:phases.map(phase=>({phase,status:phase==='preflight'?'failed':'completed'})),recovery:{phases:{preflight:{finalError:error}}}} as AutomationRun;
 const next=prepareAutomationResumeRun(old,phases,phase!);
 assert.deepEqual(next.phases.filter(x=>x.status==='pending').map(x=>x.phase),[phase,'trafficLine','preflight']);
 assert.equal(old.phases.find(x=>x.phase===phase)?.status,'completed');
 }
 assert.equal(preflightRepairPhase('登录失效'),undefined);
 assert.equal(preflightRepairPhase('酒店资源请求 HTTP 503'),undefined);
});

test('private-tour hotel repair reopens resource finalization without replaying unrelated writes',()=>{
 const phases=['basic','hotelResource','vehicleResource','terms','trafficLine','preflight'];
 const old={id:'r',status:'failed',logs:[],phases:phases.map(phase=>({phase,status:phase==='preflight'?'failed':'completed'})),recovery:{phases:{preflight:{finalError:'酒店资源只读回读第 1 段候选 ID 集合不一致：期望=123，实际='}}}} as AutomationRun;
 const next=prepareAutomationResumeRun(old,phases,'hotelResource');
 assert.deepEqual(next.phases.filter(x=>x.status==='pending').map(x=>x.phase),['hotelResource','vehicleResource','trafficLine','preflight']);
 assert.equal(next.phases.find(x=>x.phase==='terms')?.status,'completed');
});
