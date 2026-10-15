import test from "node:test";
import assert from "node:assert/strict";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { applyManualReviewField } from "../../src/main/operations/manual-review-field.js";
import { itineraryInputContractError } from "../../src/main/planning/itinerary-input-contract.js";
import { numberedRouteConstraintError } from "../../src/main/planning/numbered-route-constraints.js";
import type { ProductDetail } from "../../src/shared/contracts.js";

test("完整编号路线不能遗漏途经地，行政地点可以保存在交通活动中", () => {
  const product = buildProductSnapshot({ destination: "昆明", days: 3, productForm: "privateTour",
    userIdea: "1-昆明接---住昆明\n2-昆明---大理---丽江---丽江住宿\n3-丽江送飞机/送高铁" });
  const itinerary = [
    { day: 1, title: "昆明接团", hotel: "昆明酒店", activities: [{ type: "transport", title: "接团", detail: "昆明接团" }] },
    { day: 2, title: "途经大理前往丽江", description: "昆明出发，经大理，前往丽江", hotel: "丽江酒店", spots: [] },
    { day: 3, title: "丽江返程", activities: [{ type: "transport", title: "送机或送高铁", detail: "按时刻安排接送" }], spots: [] },
  ];
  assert.equal(numberedRouteConstraintError(product, itinerary), undefined);
  const changed = structuredClone(itinerary);
  changed[1]!.title = "前往丽江";
  changed[1]!.description = "昆明出发前往丽江";
  assert.match(numberedRouteConstraintError(product, changed) ?? "", /第 2 天.*大理/);
  changed[2]!.activities = [];
  assert.match(numberedRouteConstraintError(product, [itinerary[0]!, itinerary[1]!, changed[2]!]) ?? "", /接送安排/);
});

test("普通编号偏好列表不作为完整逐日路线", () => {
  const product = buildProductSnapshot({ destination: "昆明", days: 2, productForm: "privateTour",
    userIdea: "1.希望舒适\n2.喜欢美食" });
  assert.equal(numberedRouteConstraintError(product, [{ day: 1 }, { day: 2 }]), undefined);
});

test("美食安排的县市尾缀可规范化，不能移除餐食或改地点", () => {
  const product = buildProductSnapshot({ destination: "成都", days: 2, productForm: "privateTour", userIdea: "1-成都---郫县美食\n2-成都送机" });
  const itinerary = [{ day: 1, title: "成都出发", meals: "午餐郫美食", spots: [] }, { day: 2, title: "成都返程", activities: [{ type: "transport", title: "送机" }], spots: [] }];
  assert.equal(numberedRouteConstraintError(product, itinerary), undefined);
  itinerary[0]!.meals = "午餐自理";
  assert.match(numberedRouteConstraintError(product, itinerary) ?? "", /郫县美食/);
  itinerary[0]!.meals = "午餐彭州美食";
  assert.match(numberedRouteConstraintError(product, itinerary) ?? "", /郫县美食/);
});

test('住宿温泉不能扩展成未要求的森林公园，途经县城不能扩展成博物馆',()=>{
  const p=buildProductSnapshot({destination:'西安',days:2,productForm:'privateTour',userIdea:'1-西安接---住太白山唐镇---泡温泉\n2-佛坪---汉中送机\n住宿与商业配置：第2天返程不住宿。'});
  const itinerary:any[]=[{day:1,title:'西安接团到唐镇',hotel:'太白山唐镇酒店',description:'泡温泉',activities:[{type:'transport',title:'西安接团',detail:'接团到唐镇'}],spots:[{name:'太白山国家森林公园',kind:'attraction'}]},{day:2,title:'途经佛坪到汉中送机',activities:[{type:'transport',title:'送机',detail:'佛坪到汉中送机'}],spots:[]}];
  assert.match(numberedRouteConstraintError(p,itinerary)??'',/不能新增.*森林公园/);
  itinerary[0].spots=[{name:'温泉体验',kind:'other'}];assert.equal(numberedRouteConstraintError(p,itinerary),undefined);
  itinerary[1].spots=[{name:'佛坪秦岭人与自然博物馆',kind:'attraction'}];assert.match(numberedRouteConstraintError(p,itinerary)??'',/不能新增.*博物馆/);
});
test('明确编号景点保留原名称，真实POI别名不会被新增景点合同拒绝',()=>{
  const p=buildProductSnapshot({destination:'西安',days:2,productForm:'privateTour',userIdea:'1-张良庙---城固张骞故里---住汉中\n2-汉中送机'});
  const itinerary:any[]=[{day:1,title:'游览张良庙与城固张骞故里',hotel:'汉中酒店',spots:[{name:'张良庙',poiName:'汉中张良庙',poiId:1,kind:'attraction'},{name:'城固张骞故里',poiName:'张骞纪念馆',poiId:2,kind:'attraction'}]},{day:2,title:'汉中送机',activities:[{type:'transport',title:'汉中送机',detail:'汉中送机'}]}];
  assert.equal(numberedRouteConstraintError(p,itinerary),undefined);
});

test('运营在每日行程删除编号路线锚点后，校验不再要求该 POI，且保留标题里其它路线点', () => {
  const product = buildProductSnapshot({ destination: '西安', days: 3, productForm: 'privateTour',
    userIdea: '1-西安接---住太白山唐镇\n2-留坝县美食---张良庙---留侯住宿\n3-汉中送飞机' });
  Object.assign(product.product.basicInfo!, { days: 3, nights: 2, province: '陕西', meetingCity: '西安', destinationCity: '西安' });
  product.product.itinerary = [
    { day: 1, title: '西安接团·住太白山唐镇', description: '西安接团后前往太白山唐镇入住。', hotel: '太白山唐镇酒店',
      activities: [{ type: 'transport', title: '西安接团', detail: '西安接团' }], spots: [] },
    { day: 2, title: '太白县—留坝县美食—张良庙—留侯住宿', description: '上午前往留坝县品当地美食，下午游览张良庙，傍晚前往留侯镇入住。',
      hotel: '留侯镇酒店', spots: [{ name: '张良庙', kind: 'attraction', poiName: '张良庙', poiId: 79410 }] },
    { day: 3, title: '汉中送机', activities: [{ type: 'transport', title: '汉中送飞机', detail: '汉中送飞机' }], spots: [] },
  ] as never;
  assert.equal(numberedRouteConstraintError(product, product.product.itinerary), undefined);

  const next = applyManualReviewField(product.product, { field: 'itinerarySpotRemove', dayIndex: 1, spotIndex: 0 });
  const day = (next.itinerary as Array<Record<string, unknown>>)[1]!;
  assert.match(String(day.title), /留坝县美食/);
  assert.doesNotMatch(String(day.title), /张良庙/);

  const saved = { ...product, product: next } as ProductDetail;
  assert.equal(numberedRouteConstraintError(saved, next.itinerary as never), undefined);
  assert.equal(itineraryInputContractError(saved, next.itinerary), undefined);
});

test('已核验官方 POI 名可覆盖路线简称，但必须与 poiName 一致且已完成行政核验', () => {
  const product = buildProductSnapshot({ destination: '西安', days: 2, productForm: 'privateTour',
    userIdea: '1-西安---五丈原---四宝园---住汉中\n2-汉中送飞机' });
  Object.assign(product.product.basicInfo!, { days: 2, nights: 1, province: '陕西', meetingCity: '西安', destinationCity: '西安' });
  const conforming = [
    { day: 1, title: '西安—五丈原—四宝园—住汉中', hotel: '汉中酒店', spots: [
      { name: '五丈原', kind: 'attraction', poiName: '五丈原风景区', poiId: 144200387 },
      { name: '四宝园', kind: 'attraction', poiName: '秦岭四宝园', poiId: 145272436 },
    ] },
    { day: 2, title: '汉中送机', activities: [{ type: 'transport', title: '汉中送飞机', detail: '汉中送飞机' }], spots: [] },
  ];
  assert.equal(numberedRouteConstraintError(product, conforming as never), undefined);

  const official = structuredClone(conforming) as Array<Record<string, unknown>>;
  official[0]!.spots = [
    { name: '五丈原诸葛亮庙', kind: 'attraction', poiName: '五丈原诸葛亮庙', poiId: 85218 },
    { name: '华阳秦岭四宝园', kind: 'attraction', poiName: '华阳秦岭四宝园', poiId: 145272436 },
  ];
  // 缺行政核验记录：fail closed，官方别名不放行。
  assert.match(numberedRouteConstraintError(product, official as never) ?? '', /不能新增或替换景点.*五丈原诸葛亮庙/);

  // 已完成路线行政核验且未把锚点判为行政节点：官方别名放行。
  (product.product as Record<string, unknown>).diagnostics = { routeAdministrativeNodes: [] };
  assert.equal(numberedRouteConstraintError(product, official as never), undefined);

  // 自造标签：name 与官方 poiName 不一致，只是拿真实 POI 给自己的名字背书，仍然拒绝。
  const fabricated = structuredClone(official) as Array<Record<string, unknown>>;
  (fabricated[0]!.spots as Array<Record<string, unknown>>)[0] = { name: '五丈原秦岭人与自然博物馆', kind: 'attraction', poiName: '五丈原风景区', poiId: 144200387 };
  assert.match(numberedRouteConstraintError(product, fabricated as never) ?? '', /不能新增或替换景点.*博物馆/);
});

test('无行政尾缀的裸途经短名：即使 name 与 poiName 都是真实官方名也不能扩成景点', () => {
  const product = buildProductSnapshot({ destination: '西安', days: 2, productForm: 'privateTour',
    userIdea: '1-西安接---住太白山唐镇\n2-佛坪---汉中送飞机' });
  Object.assign(product.product.basicInfo!, { days: 2, nights: 1, province: '陕西', meetingCity: '西安', destinationCity: '西安' });
  const expanded = () => [
    { day: 1, title: '西安接团·住太白山唐镇', activities: [{ type: 'transport', title: '西安接团', detail: '西安接团' }], spots: [] },
    { day: 2, title: '途经佛坪到汉中送机', activities: [{ type: 'transport', title: '汉中送飞机', detail: '汉中送飞机' }],
      spots: [{ name: '佛坪熊猫谷', kind: 'attraction', poiName: '佛坪熊猫谷', poiId: 22883772 }] },
  ];
  // 缺路线行政核验记录 → fail closed。
  assert.match(numberedRouteConstraintError(product, expanded() as never) ?? '', /不能新增.*熊猫谷/);
  // 有核验记录，但佛坪被判为行政节点 → 仍然拒绝。
  (product.product as Record<string, unknown>).diagnostics = { routeAdministrativeNodes: [{ day: 2, name: '佛坪', districtId: 7568 }] };
  assert.match(numberedRouteConstraintError(product, expanded() as never) ?? '', /不能新增.*熊猫谷/);
  // 同一份行程按路线原文名写入（首选写法）始终通过。
  const conforming = expanded();
  conforming[1]!.spots = [{ name: '佛坪', kind: 'attraction', poiName: '佛坪熊猫谷', poiId: 22883772 }];
  assert.equal(numberedRouteConstraintError(product, conforming as never), undefined);
});

test('行政锚点不能靠已核验官方名扩展成景区', () => {
  const product = buildProductSnapshot({ destination: '西安', days: 2, productForm: 'privateTour',
    userIdea: '1-西安---太白县---住西安\n2-汉中送飞机' });
  Object.assign(product.product.basicInfo!, { days: 2, nights: 1, province: '陕西', meetingCity: '西安', destinationCity: '西安' });
  const itinerary = [
    { day: 1, title: '西安—太白县—住西安', hotel: '西安酒店', spots: [
      { name: '太白县青峰峡森林公园', kind: 'attraction', poiName: '太白县青峰峡森林公园', poiId: 100 },
    ] },
    { day: 2, title: '汉中送机', activities: [{ type: 'transport', title: '汉中送飞机', detail: '汉中送飞机' }], spots: [] },
  ];
  assert.match(numberedRouteConstraintError(product, itinerary as never) ?? '', /不能新增.*森林公园/);
});

test('途经县城扩展到景区时，带 VBK POI 身份也不能绕过编号路线约束', () => {
  const product = buildProductSnapshot({ destination: '西安', days: 2, productForm: 'privateTour',
    userIdea: '1-西安接---住太白山唐镇\n2-佛坪---汉中送飞机' });
  Object.assign(product.product.basicInfo!, { days: 2, nights: 1, province: '陕西', meetingCity: '西安', destinationCity: '西安' });
  const itinerary = [
    { day: 1, title: '西安接团·住太白山唐镇', activities: [{ type: 'transport', title: '西安接团', detail: '西安接团' }], spots: [] },
    { day: 2, title: '途经佛坪到汉中送机', activities: [{ type: 'transport', title: '汉中送飞机', detail: '汉中送飞机' }],
      spots: [{ name: '佛坪秦岭人与自然博物馆', kind: 'attraction', poiName: '佛坪熊猫谷', poiId: 22883772 }] },
  ];
  assert.match(numberedRouteConstraintError(product, itinerary as never) ?? '', /不能新增.*博物馆/);
});
