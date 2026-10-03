import test from 'node:test';
import assert from 'node:assert/strict';
import {submitGroupPricingBatches} from '../../src/main/automation/ctrip/pricing-group-batch.js';
import {buildGroupPricingExpectation} from '../../src/main/automation/ctrip/pricing-group-contract.js';
import {priceInventorySingleProductBody} from '../../src/main/automation/ctrip/pricing-group-submit.js';
import {datesBetween} from '../../src/main/automation/ctrip/pricing-api.js';
import {ageBands,product,rowsFromSaveBody} from './pricing-fixture.js';
const expected=buildGroupPricingExpectation(ageBands,product.commercial.pricing,8);
const dates=datesBetween('2027-01-01','2027-12-31');
function fixture() {
  const saved=new Map<string,any>();const calls:string[][]=[];const logs:string[]=[];
  const save=(batch:string[])=>{
    const body=priceInventorySingleProductBody('123',{},batch,product.commercial.pricing,expected);
    for(const row of rowsFromSaveBody(body))saved.set(row.productDate,row);
  };
  const options={dates,remainingDates:dates,expected,readRows:async()=>[...saved.values()],
    pause:async()=>{},onProgress:(message:string)=>{logs.push(message);}};
  return {saved,calls,logs,save,options};
}

test('全年批次失败后按日历季度提交，季度成功后不再按月或日', async()=>{
  const f=fixture();await submitGroupPricingBatches({...f.options,submit:async batch=>{
    f.calls.push(batch);if(batch.length>92)throw Error('批次太大');f.save(batch);
  }});
  assert.deepEqual(f.calls.map(b=>b.length),[300,65,90,91,92,27]);
  assert.equal(f.saved.size,365);
  assert.ok(f.logs.some(l=>l.includes('按季度')));assert.ok(!f.logs.some(l=>l.includes('按月份')));
});

test('季度仍失败按月提交，成功的跨季度末尾 65 天不重复写入', async()=>{
  const f=fixture();await submitGroupPricingBatches({...f.options,submit:async batch=>{
    f.calls.push(batch);if(f.calls.length===2 && batch.length===65){f.save(batch);return;}
    if(batch.length>31)throw Error('只支持月份');f.save(batch);
  }});
  assert.equal(f.saved.size,365);
  const monthly=f.calls.slice(2+4);
  assert.ok(monthly.every(batch=>batch.every(date=>date.slice(0,7)===batch[0].slice(0,7))));
  // 季度阶段的最后 27 天已成功，因此月份阶段只补前三个季度。
  assert.equal(monthly.reduce((sum,b)=>sum+b.length,0),273);
  assert.ok(!f.logs.some(l=>l.includes('按逐日')));
});

for (const remainingCount of [99,100]) {
  test(`部分成功后剩余 ${remainingCount} 天：仅 99 天允许逐日`,async()=>{
    const f=fixture();let initial=true;
    const operation=submitGroupPricingBatches({...f.options,submit:async batch=>{
      f.calls.push(batch);
      if(initial){initial=false;f.save(batch.slice(0,300-remainingCount));throw Error('部分成功后中断');}
      if(batch.length===65){f.save(batch);return;}
      if(batch.length>1)throw Error('批量暂不可用');
      f.save(batch);
    }});
    if(remainingCount===99){await operation;assert.equal(f.saved.size,365);assert.equal(f.calls.filter(b=>b.length===1).length,99);}
    else{await assert.rejects(operation,/剩余 100 天.*仅少于 100 天/);assert.equal(f.calls.filter(b=>b.length===1).length,0);}
    const existing=new Set(dates.slice(0,300-remainingCount));
    assert.ok(f.calls.slice(2).every(batch=>batch.every(date=>!existing.has(date))));
  });
}

test('Ack 成功但漏日也降级修复，远端回读失败时不盲目继续写入',async()=>{
  const f=fixture();let first=true;
  await submitGroupPricingBatches({...f.options,submit:async batch=>{
    f.calls.push(batch);if(first){first=false;f.save(batch.slice(1));}else f.save(batch);
  }});
  assert.equal(f.saved.size,365);assert.deepEqual(f.calls.at(-1),[dates[0]]);
  const broken=fixture();let readCount=0;
  await assert.rejects(submitGroupPricingBatches({...broken.options,submit:async batch=>{broken.calls.push(batch);throw Error('连接中断');},
    readRows:async()=>{readCount++;throw Error('无法核对远端');}}),/无法核对远端/);
  assert.equal(readCount,1);assert.equal(broken.calls.length,2);
});
