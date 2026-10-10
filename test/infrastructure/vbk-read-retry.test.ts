import test from 'node:test';
import assert from 'node:assert/strict';
import { retryVbkRead } from '../../src/main/infrastructure/vbk-read-retry.js';

test('read retries transient network failures with a bounded budget', async () => {
  let count=0; const waits:number[]=[];
  assert.equal(await retryVbkRead(async()=>{if(++count<3)throw new Error('net::ERR_FAILED');return 'read';},async ms=>{waits.push(ms);}), 'read');
  assert.equal(count,3);assert.deepEqual(waits,[500,1000]);
  count=0;
  await assert.rejects(retryVbkRead(async()=>{count++;throw new Error('net::ERR_FAILED');},async()=>{}),/ERR_FAILED/);
  assert.equal(count,3);
});
test('business/protocol errors are not retried',async()=>{
  let count=0;
  await assert.rejects(retryVbkRead(async()=>{count++;throw new Error('Ack Failure: invalid product');},async()=>{}),/Ack Failure/);
  assert.equal(count,1);
});
