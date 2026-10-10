import test from "node:test";
import assert from "node:assert/strict";
import { resolveItineraryHotelCandidates } from "../../src/main/infrastructure/ctrip-hotel-search.js";
const html=(hotelList: unknown[])=>`<script>self.__next_f.push(${JSON.stringify([1,JSON.stringify({initListData:{hotelList}})])})</script>`;
async function search(mode:"lowest"|"empty"|"captcha"|"network",allow=true){
 const original=globalThis.fetch,grades:number[]=[];
 globalThis.fetch=async input=>{
  const url=String(input);
  if(url.includes("gaHotelSearchEngine"))return Response.json({Response:{searchResults:[{id:"1",cityId:21367,cityName:"留坝",word:"留侯古镇",type:"Markland",gLat:33.69,gLon:106.85}]}});
  const grade=Number(new URL(url).searchParams.get("listFilters")?.match(/16~(\d)/)?.[1] ?? 0);grades.push(grade);
  if(mode==="network")return new Response("offline",{status:503});
  if(mode==="captcha")return new Response("<html>登录或验证码</html>");
  const rows=mode==="lowest"&&grade===1?[{hotelInfo:{summary:{hotelId:1001},nameInfo:{name:"留侯酒店"},hotelStar:{star:1,starType:0},commentInfo:{commentScore:4.5},positionInfo:{cityId:21367,cityName:"留坝",mapCoordinate:[{latitude:33.69,longitude:106.85}]}}}]:[];
  return new Response(html(rows));
 };
 try{return {result:await resolveItineraryHotelCandidates([{day:3,hotel:"留侯酒店"}],"西安",5,"当地5钻酒店",undefined,new Map([[3,{anchorName:"留侯",cityName:"留坝",maxDistanceKm:5}]]),allow),grades};}
 catch(error){return {error,grades};}finally{globalThis.fetch=original;}
}
test("空列表不能在5钻中断，按授权依次查到1钻并返回真实候选",async()=>{
 const r=await search("lowest");assert.deepEqual(r.grades,[5,4,3,2,1]);assert.equal(r.result?.dailyCandidates[0].candidates[0].diamond,1);
});
test("全部空列表仍尝试全部档次，但保持不确定错误，不伪造无酒店结论",async()=>{
 const r=await search("empty");assert.deepEqual(r.grades,[5,4,3,2,1,0]);assert.match(String(r.error),/可能触发验证码或该日期无房/);assert.equal(r.result,undefined);
});
test("未允许降档、网络异常、不可解析验证码页面不盲目重试",async()=>{
 for(const [mode,allow] of [["empty",false],["network",true],["captcha",true]] as const){const r=await search(mode,allow);assert.deepEqual(r.grades,[5]);assert.ok(r.error);}
});
