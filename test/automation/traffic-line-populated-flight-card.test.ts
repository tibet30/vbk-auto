import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeTrafficNodes,verifyTrafficNodes} from '../../src/main/automation/ctrip/traffic-line/itinerary.js';
test('populated flight cards must disable segment configuration before VBK validation',()=>{
 const endpoints={arrivalCity:'北京',departureCity:'北京',resolvedAt:'2026-10-08',flight:{arrival:{code:'PEK',name:'首都国际机场'},departure:{code:'PEK',name:'首都国际机场'}}};
 const source={activeType:{key:2,name:'航班'},useSegmentConfig:true};
 const tour={tourDailyDescriptions:[{tourDailyInfos:[]},{tourDailyInfos:[]}]};
 const populated=mergeTrafficNodes(tour,source,source,'flightRoundTrip',endpoints);
 const days=populated.tourDailyDescriptions as Array<{tourDailyInfos:Array<Record<string,unknown>>}>;
 days.forEach(day=>day.tourDailyInfos[0]!.useSegmentConfig=true);
 const repaired=mergeTrafficNodes(populated,days[0]!.tourDailyInfos[0]!,days[1]!.tourDailyInfos[0]!,'flightRoundTrip',endpoints);
 const repairedDays=repaired.tourDailyDescriptions as typeof days;
 assert.equal(verifyTrafficNodes(repaired,'flightRoundTrip'),2);
 assert.ok(repairedDays.every(day=>day.tourDailyInfos[0]!.useSegmentConfig===false));
});
test('actual station-list train cards survive repeated materialization without fabricated legacy fields',()=>{
 const first={activeType:{key:14,name:'火车'},useSegmentConfig:true,tourDailyPackageTrains:[{arriveStationList:[{stationName:'北京',locationCode:'CN001BJP'}],departureStationList:[]}]};
 const last={activeType:{key:14,name:'火车'},useSegmentConfig:true,tourDailyPackageTrains:[{departureStationList:[{stationName:'北京',locationCode:'CN001BJP'}],arriveStationList:[]}]};
 const tour={tourDailyDescriptions:[{tourDailyInfos:[first]},{tourDailyInfos:[{activeType:{key:14,name:'火车'},useSegmentConfig:true,tourDailyPackageTrains:[]}]}]};
 assert.throws(()=>verifyTrafficNodes(tour,'trainRoundTrip'),/缺少首日或末日/);
 const merged=mergeTrafficNodes(tour,first,last,'trainRoundTrip');
 assert.equal(verifyTrafficNodes(merged,'trainRoundTrip'),2);
 const days=merged.tourDailyDescriptions as Array<{tourDailyInfos:Array<Record<string,unknown>>}>;
 assert.deepEqual(days[1]!.tourDailyInfos[0]!.tourDailyPackageTrains,last.tourDailyPackageTrains);
 assert.equal(days[1]!.tourDailyInfos[0]!.useSegmentConfig,false);
 assert.equal(days[1]!.tourDailyInfos[0]!.tourDailyTrains,undefined);
});
