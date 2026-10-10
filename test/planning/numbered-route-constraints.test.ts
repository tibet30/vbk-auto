import test from "node:test";
import assert from "node:assert/strict";
import { buildProductSnapshot } from "../../src/main/infrastructure/database/parts/product-draft.js";
import { numberedRouteConstraintError } from "../../src/main/planning/numbered-route-constraints.js";

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
