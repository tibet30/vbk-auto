import test from 'node:test';
import assert from 'node:assert/strict';
import {trafficClauseMaterializationCanResume,trafficResourceCardRejected} from '../../src/main/automation/ctrip/traffic-line/child-failure.js';
import type {TrafficLineChildProgress} from '../../src/shared/contracts-traffic-line.js';
test('explicit card rejection may recover previously saved resources, unknown submissions cannot',()=>{
 const p={childProductId:'1',variant:'trainRoundTrip',validationSubmittedAt:'2026-10-08',completedStages:['resourcesSaved','itinerarySaved'],failedStage:'activated',failureReason:'子产品资源提交未通过：资源配置中含有火车票资源，需要行程描述中先添加火车信息卡片。'} as TrafficLineChildProgress;
 assert.equal(trafficClauseMaterializationCanResume(p),true);
 assert.equal(trafficClauseMaterializationCanResume({...p,validationSubmittedAt:undefined}),false);
 assert.equal(trafficClauseMaterializationCanResume({...p,completedStages:['itinerarySaved']}),false);
 assert.equal(trafficClauseMaterializationCanResume({...p,failureReason:'请求超时'}),false);
});
test('an explicit resource-stage card rejection requires remote evidence instead of replaying the old submission',()=>{
 const p={childProductId:'1',variant:'trainRoundTrip',validationSubmittedAt:'2026-10-08',completedStages:['presentationCopied'],failedStage:'resourcesSaved',failureReason:'子产品资源提交未通过：资源配置中含有火车票资源，需要行程描述中先添加火车信息卡片。'} as TrafficLineChildProgress;
 assert.equal(trafficResourceCardRejected(p),true);
 assert.equal(trafficResourceCardRejected({...p,validationSubmittedAt:undefined}),false);
 assert.equal(trafficResourceCardRejected({...p,completedStages:[]}),false);
 assert.equal(trafficResourceCardRejected({...p,failureReason:'请求超时'}),false);
 assert.equal(trafficResourceCardRejected({...p,failedStage:'activated'}),false);
});
