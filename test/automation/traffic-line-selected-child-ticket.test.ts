import test from 'node:test';
import assert from 'node:assert/strict';
import {desiredFirstTabClauses,resolveChildTransportClauseRequirements} from '../../src/main/automation/ctrip/traffic-line/clauses.js';
test('three child ticket options use the platform selected option and reject ambiguous selection',()=>{
 const item=(id:number,value:string,selected='T')=>({clauseItemId:id,selected,hasSelectBox:'T',clauseComponentDtos:[{componentCode:'text',value}]});
 const children=[item(10071,'儿童是否含火车票，以订单选择为准'),item(10073,'儿童含半价火车票','F'),item(10074,'儿童含全价火车票','F')];
 const pack={clauseTypeDtos:[{clauseTypeId:86,clauseItemDtos:[item(38725,'去程火车票'),item(38739,'返程火车票'),...children]}]};
 assert.deepEqual(resolveChildTransportClauseRequirements(pack,'trainRoundTrip').map(x=>x.clauseItemId),[38725,38739,10071]);
 children[1]!.selected='T';assert.throws(()=>resolveChildTransportClauseRequirements(pack,'trainRoundTrip'),/儿童票说明（候选 2 项）/);
});
test('unselected child ticket options use the unique platform order-age condition',()=>{
 const item=(id:number,value:string,selected='F')=>({clauseItemId:id,selected,hasSelectBox:'T',clauseComponentDtos:[{componentCode:'text',value}]});
 const neutral=item(10071,'儿童是否含火车票，以您在填写订单时选择的儿童年龄为准');
 const half=item(10073,'儿童含半价火车票');
 const full=item(10074,'儿童含全价火车票');
 const pack={clauseTypeDtos:[{clauseTypeId:86,clauseItemDtos:[item(38725,'去程火车票','T'),item(38739,'返程火车票','T'),neutral,half,full]}]};
 assert.deepEqual(resolveChildTransportClauseRequirements(pack,'trainRoundTrip').map(x=>x.clauseItemId),[38725,38739,10071]);
 half.selected='T';
 assert.deepEqual(resolveChildTransportClauseRequirements(pack,'trainRoundTrip').map(x=>x.clauseItemId),[38725,38739,10073]);
});
test('unselected child fares without a unique order-age condition remain blocked',()=>{
 const item=(id:number,value:string)=>({clauseItemId:id,selected:'F',hasSelectBox:'T',clauseComponentDtos:[{componentCode:'text',value}]});
 const base=[item(38725,'去程火车票'),item(38739,'返程火车票'),item(10073,'儿童含半价火车票'),item(10074,'儿童含全价火车票')];
 const pack={clauseTypeDtos:[{clauseTypeId:86,clauseItemDtos:base}]};
 assert.throws(()=>resolveChildTransportClauseRequirements(pack,'trainRoundTrip'),/儿童票说明（候选 0 项）/);
 base.push(item(10071,'儿童是否含火车票，以订单选择的儿童年龄为准'),item(20071,'儿童是否含火车票，以订单选择的儿童年龄为准'));
 assert.throws(()=>resolveChildTransportClauseRequirements(pack,'trainRoundTrip'),/儿童票说明（候选 2 项）/);
});
test('required-item suggestions cannot add competing child fares to a confirmed choice',()=>{
 const item=(id:number,value:string,selected='F')=>({clauseItemId:id,selected,hasSelectBox:'T',clauseComponentDtos:[{componentCode:'text',value}]});
 const pack={clauseTypeDtos:[{clauseTypeId:86,clauseItemDtos:[item(38725,'去程火车票','T'),item(38739,'返程火车票','T'),item(10071,'儿童是否含火车票，以订单选择的儿童年龄为准','T'),item(10073,'儿童含半价火车票'),item(10074,'儿童含全价火车票')]},{clauseTypeId:316,clauseItemDtos:[item(33006,'目的地接送')]}]};
 const suggested=[10071,10073,10074].map(id=>({clauseItemId:id,secondClassTypeId:86,elementDtos:[]}));
 assert.deepEqual(desiredFirstTabClauses(pack,suggested,'trainRoundTrip').map(x=>x.clauseItemId),[10071,38725,38739,33006]);
});
