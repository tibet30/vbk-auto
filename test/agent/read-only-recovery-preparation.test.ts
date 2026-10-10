import test from 'node:test';
import assert from 'node:assert/strict';
import {isPreparationRun,PRODUCT_PREPARATION_INSTRUCTION} from '../../src/main/agent/preparation-run.js';
import type {AgentSnapshot} from '../../src/shared/contracts.js';
const snapshot=(content:string)=>({run:{id:'r'},events:[{runId:'r',type:'user',content:PRODUCT_PREPARATION_INSTRUCTION},{runId:'r',type:'user',content}]} as AgentSnapshot);
test('explicit read-only reconciliation does not revive historical preparation',()=>{
 assert.equal(isPreparationRun(snapshot('仅进行只读恢复：调用 read_vbk_creation_recovery，scope="all"，不修改方案。')),false);
 assert.equal(isPreparationRun(snapshot('继续')),true);
 assert.equal(isPreparationRun(snapshot('当前状态是什么')),true);
});
