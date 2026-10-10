import test from 'node:test';
import assert from 'node:assert/strict';
import {buildProductSnapshot} from '../../src/main/infrastructure/database/parts/product-draft.js';
import {normaliseNumberedRouteAdministrativeNodes,exactRouteAdministrativeDistrict} from '../../src/main/planning/numbered-route-administrative.js';
const district={districtId:1,districtName:'测试县',districtType:'City',parents:[{districtName:'陕西',districtType:'Province'}]};
test('only a unique platform administrative match in the locked province qualifies',()=>{
  assert.equal(exactRouteAdministrativeDistrict({districts:[district]},'测试','陕西'),district);
  assert.equal(exactRouteAdministrativeDistrict({districts:[district,district]},'测试','陕西'),undefined);
  assert.equal(exactRouteAdministrativeDistrict({districts:[district]},'测试','四川'),undefined);
  assert.equal(exactRouteAdministrativeDistrict({districts:[{...district,districtType:'Town'}]},'测试','陕西'),undefined);
});
test('bare route administrative node is preserved in transport, verified named POI stays',async()=>{
  const p=buildProductSnapshot({destination:'西安',days:2,productForm:'privateTour',userIdea:'1-西安接---住西安\n2-测试---张良庙---西安送机'});
  Object.assign(p.product.basicInfo!,{province:'陕西'});
  p.product.itinerary=[{day:1,spots:[]},{day:2,description:'测试停留后去张良庙，返回西安送机',spots:[{name:'测试',kind:'attraction',poiId:null,poiName:null},{name:'张良庙',kind:'attraction',poiId:2,poiName:'张良庙'}]}] as any;
  let calls=0;
  const result=await normaliseNumberedRouteAdministrativeNodes(p,{nativeOnly:true,vbkSessionFetch:async()=>{calls++;return {status:200,payload:{ResponseStatus:{Ack:'Success'},districts:[district]}};}} as any);
  assert.equal(calls,1);assert.deepEqual(result?.converted,[{day:2,name:'测试',districtId:1}]);
  assert.deepEqual(result?.itinerary[1].spots.map((s:any)=>s.name),['张良庙']);
  assert.match(result?.itinerary[1].activities[0].detail,/测试停留/);
  assert.equal((p.product.itinerary as any)[1].spots.length,2,'source is untouched until controlled persistence');
});

test('dated D routes normalize unique cross-province administrative anchors and cache repeated reads', async () => {
  const p = buildProductSnapshot({ destination: '西宁', days: 2, productForm: 'privateTour',
    userIdea: '**10 月 4 号 D1：** 西宁 - 茶卡盐湖 - 瓜州\n**10 月 5 号 D2：** 瓜州 - 敦煌' });
  Object.assign(p.product.basicInfo!, { province: '青海' });
  p.product.itinerary = [{ day: 1, description: '西宁经茶卡盐湖到瓜州', spots: [{ name: '西宁' },
    { name: '茶卡盐湖', poiId: 2, poiName: '茶卡盐湖' }, { name: '瓜州' }] },
    { day: 2, description: '瓜州到敦煌散团', spots: [{ name: '瓜州' }, { name: '敦煌' }] }] as any;
  const queries: string[] = [];
  const result = await normaliseNumberedRouteAdministrativeNodes(p, { nativeOnly: true, vbkSessionFetch: async (request: any) => {
    const name = request.body.keyword; queries.push(name);
    return { status: 200, payload: { ResponseStatus: { Ack: 'Success' }, districts: [{ districtId: 3,
      districtName: `${name}市`, districtType: 'City', parents: [{ districtName: '甘肃', districtType: 'Province' }] }] } };
  } } as any);
  assert.deepEqual(queries, ['西宁', '瓜州', '敦煌']);
  assert.equal(result?.converted.length, 4);
  assert.deepEqual(result?.itinerary[0].spots.map((s: any) => s.name), ['茶卡盐湖']);
  assert.equal(result?.itinerary[1].spots.length, 0);
  assert.match(result?.itinerary[1].activities.map((a: any) => `${a.title} ${a.detail}`).join(' '), /瓜州.*敦煌/);
  assert.equal(p.product.itinerary[0]?.spots?.length, 3);
});
