import test from 'node:test';
import assert from 'node:assert/strict';
import {datesBetween, ensurePricingInventoryApi, localBusinessDate} from '../../src/main/automation/ctrip/pricing-api.js';
import {priceInventorySingleProductBody} from '../../src/main/automation/ctrip/pricing-group-submit.js';
import {buildGroupPricingExpectation} from '../../src/main/automation/ctrip/pricing-group-contract.js';
import {success, ageBands, product, browserWithHandler, rowsFromSaveBody, baseEndpointPayload} from './pricing-fixture.js';

function yearlyProduct() {
  const end=new Date(); end.setDate(end.getDate()+364);
  return {...product, commercial:{...product.commercial,inventory:{...product.commercial.inventory,endDate:localBusinessDate(end)}}};
}

test('全年 365 天首次录入使用 300+65 两批，均为四档模板并回读每一天', async()=>{
  const p=yearlyProduct(); const dates=datesBetween(p.commercial.inventory.startDate,p.commercial.inventory.endDate);
  const rows:any[]=[]; let inFlight=0; let peak=0;
  const browser=browserWithHandler(async(path, body)=>{
    const base=baseEndpointPayload(path);if(base)return base;
    if(path==='GetBatchOperateSchedule')return {...success,dates:rows.filter(row=>row.productDate.startsWith(body.yearMonth))};
    if(path==='savePriceInventorySingleProduct'){
      inFlight++;peak=Math.max(peak,inFlight);await Promise.resolve();
      rows.push(...rowsFromSaveBody(body));inFlight--;return success;
    }
    throw Error(path);
  });
  const pauses:number[]=[];
  const result=await ensurePricingInventoryApi(browser as never,p,'123',{pause:async ms=>{pauses.push(ms);}});
  const saves=browser.calls.filter(c=>c.path==='savePriceInventorySingleProduct');
  assert.deepEqual(saves.map(c=>c.body.dateChoose.dates.length),[300,65]);
  assert.deepEqual(saves.flatMap(c=>c.body.dateChoose.dates),dates);
  assert.ok(saves.every(c=>c.body.singleResourceUnitPriceInventory.singleResourceUnitPriceDtos.length===4));
  assert.equal(peak,1);assert.equal(pauses.length,1);assert.equal(result.dateCount,365);
});

test('全年已完整保存时不提交价格，少量错价只精确提交缺失日期', async()=>{
  const p=yearlyProduct();const dates=datesBetween(p.commercial.inventory.startDate,p.commercial.inventory.endDate);
  const expected=buildGroupPricingExpectation(ageBands,p.commercial.pricing,8);
  const body=priceInventorySingleProductBody('123',{singleResourceId:7001,optionalResourceId:8001},dates,p.commercial.pricing,expected);
  const rows=rowsFromSaveBody(body);
  const browser=browserWithHandler((path,body)=>{
    const base=baseEndpointPayload(path);if(base)return base;
    if(path==='GetBatchOperateSchedule')return {...success,dates:rows.filter((row:any)=>row.productDate.startsWith(body.yearMonth))};
    if(path==='savePriceInventorySingleProduct'){
      for(const row of rowsFromSaveBody(body)){const index=rows.findIndex((r:any)=>r.productDate===row.productDate);rows[index]=row;}
      return success;
    }
    throw Error(path);
  });
  await ensurePricingInventoryApi(browser as never,p,'123',{pause:async()=>{}});
  assert.equal(browser.calls.filter(c=>c.path==='savePriceInventorySingleProduct').length,0);
  rows[1].singleResourceUnitPriceDtos[0].costPrice=0;
  rows[364].inventory.total=1;
  await ensurePricingInventoryApi(browser as never,p,'123',{pause:async()=>{}});
  const saves=browser.calls.filter(c=>c.path==='savePriceInventorySingleProduct');
  assert.equal(saves.length,1);assert.deepEqual(saves[0].body.dateChoose.dates,[dates[1],dates[364]]);
});

test('批量业务错误依次缩小范围，全年失败不会降级逐日；最终漏日不能报成功', async()=>{
  const p=yearlyProduct();let failSave=true;
  const rows:any[]=[];
  const browser=browserWithHandler((path,body)=>{
    const base=baseEndpointPayload(path);if(base)return base;
    if(path==='GetBatchOperateSchedule')return {...success,dates:rows.filter(row=>row.productDate.startsWith(body.yearMonth))};
    if(path==='savePriceInventorySingleProduct'){
      if(failSave)return {ResponseStatus:{Ack:'Failure',Errors:[{ErrorCode:'OTHER',Message:'校验失败'}]}};
      rows.push(...rowsFromSaveBody(body).slice(1));return success;
    }
    throw Error(path);
  });
  await assert.rejects(ensurePricingInventoryApi(browser as never,p,'123',{pause:async()=>{}}),/校验失败/);
  const failedBatches=browser.calls.filter(c=>c.path==='savePriceInventorySingleProduct');
  assert.ok(failedBatches.length>2);
  assert.ok(failedBatches.some(c=>c.body.dateChoose.dates.length<=92));
  assert.ok(failedBatches.every(c=>c.body.dateChoose.dates.length>1));
  failSave=false;
  await assert.rejects(ensurePricingInventoryApi(browser as never,p,'123',{pause:async()=>{}}),/回读不一致/);
});
