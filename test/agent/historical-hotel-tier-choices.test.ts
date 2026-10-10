import test from "node:test";
import assert from "node:assert/strict";
import { historicalHotelTierInstruction } from "../../src/main/agent/historical-hotel-tier-choices.js";
import { applyPersistedHotelTierChoices } from "../../src/main/agent/integration-patch.js";
import type { ProductDetail } from "../../src/shared/contracts.js";
const product = (id: string) => ({id,vbkAccount:"account",product:{basicInfo:{userIdea:"3-太白---留坝县---留侯住宿"},operations:{hotelTier:"当地5钻酒店",hotelFallbackPolicy:{allowDowngrade:true}},itinerary:[{day:3,hotel:"留侯酒店",hotelRequirement:{anchorName:"留侯",cityName:"留坝",maxDistanceKm:5}}]}} as unknown as ProductDetail);
function fixture() {
 const current=product("new"),old=product("old");
 const events: any = {old:[{type:"user",content:'{"hotel3":"接受3圆钻民宿，保留留侯原定住宿地点"}'}],new:[]};
 const db:any={listProducts:()=>[{id:"old",updatedAt:"2026-10-07"}],getProduct:()=>old,getAgentSnapshot:(id:string)=>({events:events[id]})};
 return {current,old,events,db};
}
test("同账号同原始行程同落脚点，新产品复用已明确确认的住宿类型",()=>{
 const f=fixture();const instruction=historicalHotelTierInstruction(f.db,f.current);
 const next=applyPersistedHotelTierChoices(f.current.product,instruction) as any;
 assert.equal(next.itinerary[0].hotelRequirement.ratingType,"homestay");
 assert.equal(next.itinerary[0].hotelRequirement.diamond,3);
 assert.equal(next.itinerary[0].hotelRequirement.anchorName,"留侯");
 assert.equal(next.itinerary[0].hotelRequirement.maxDistanceKm,5);
});
test("不同账号、不同路线、关闭降档、不同住宿地点或距离不得继承",()=>{
 for(const change of [(f:any)=>f.old.vbkAccount="other",(f:any)=>f.old.product.basicInfo.userIdea="其他路线",(f:any)=>f.current.product.operations.hotelFallbackPolicy.allowDowngrade=false,(f:any)=>f.old.product.itinerary[0].hotelRequirement.anchorName="汉中",(f:any)=>f.old.product.itinerary[0].hotelRequirement.maxDistanceKm=50]){
 const f=fixture();change(f);assert.equal(historicalHotelTierInstruction(f.db,f.current),"");
 }
});
test("新产品的逐日选择、自由文本要求、拒绝民宿优先于旧选择",()=>{
 for(const content of ['{"hotel3":"保留5钻酒店"}',"D3 使用5钻酒店","第3天不要民宿","只接受酒店","中文hotel3：保留5钻酒店"]){
 const f=fixture();f.events.new=[{type:"user",content}];assert.equal(historicalHotelTierInstruction(f.db,f.current),"");
 }
});

test("逐日标记使用数字边界，不把 hotel30 或 D30 误判成第 3 天",()=>{
 const f=fixture();f.events.new=[{type:"user",content:"hotel30 与 D30 另行处理"}];
 assert.notEqual(historicalHotelTierInstruction(f.db,f.current),"");
});
test("旧的模型文字、酒店候选或修改住宿地点的许可不作为继承授权",()=>{
 const f=fixture();f.events.old=[{type:"assistant",content:'{"hotel3":"接受3圆钻民宿"}'}];assert.equal(historicalHotelTierInstruction(f.db,f.current),"");
 f.events.old=[{type:"user",content:'{"hotel3":"改住汉中3钻酒店"}'}];assert.equal(historicalHotelTierInstruction(f.db,f.current),"");
});
test("按真实回答时间排序，重新打开旧产品不能复活旧的住宿许可",()=>{
 const f=fixture(),second=product("second");
 f.events.old=[{type:"user",createdAt:"2026-10-06",content:'{"hotel3":"接受3圆钻民宿"}'}];
 f.events.second=[{type:"user",createdAt:"2026-10-07",content:'{"hotel3":"不要降为3圆钻民宿"}'}];
 f.db.listProducts=()=>[{id:"second",updatedAt:"2026-10-07"},{id:"old",updatedAt:"2026-10-08"}];
 f.db.getProduct=(id:string)=>id==="old"?f.old:second;
 const instruction=historicalHotelTierInstruction(f.db,f.current);
 assert.equal(applyPersistedHotelTierChoices(f.current.product,instruction),f.current.product);
});
