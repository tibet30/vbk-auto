import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentConversation } from '../../../src/renderer/app/views/workspace/agent-conversation';
import '../../../src/renderer/styles/tokens.css';
import '../../../src/renderer/styles/global.css';
import type { AgentSnapshot, VbkApi, ProductDetail, AgentInputResponse } from '../../../src/shared/contracts';
const now = () => new Date().toISOString();
const request = { id:'question-1', createdAt:now(), questions:[
  { id:'pace', label:'希望每天怎样安排？',kind:'single' as const,required:true,options:[{id:'slow',label:'轻松一些'},{id:'full',label:'多安排景点'}]},
  { id:'copy', label:'请补充你希望保留的文案',kind:'text' as const,required:true},
]};
let snapshot: AgentSnapshot = {localProductId:'fixture',run:{id:'run-1',status:'waiting_input',createdAt:now(),updatedAt:now()},pendingInput:request,events:[
  {id:'1',runId:'run-1',type:'user',createdAt:now(),content:'安排成都两天一晚，带孩子，想轻松一点。'},
  {id:'2',runId:'run-1',type:'assistant',createdAt:now(),content:'<think>先核对景点和酒店资源，再向用户确认节奏。</think>\n我会先核查适合的景点和酒店，再完善右侧行程。',data:{modelTurnId:'turn-1'}},
  {id:'3',runId:'run-1',type:'tool_call',createdAt:now(),content:'query_poi',data:{modelTurnId:'turn-1',toolCallId:'a',name:'query_poi',arguments:{keyword:'成都熊猫基地'}}},
  {id:'4',runId:'run-1',type:'tool_call',createdAt:now(),content:'query_hotel_resource',data:{modelTurnId:'turn-1',toolCallId:'b',name:'query_hotel_resource',arguments:{city:'成都'}}},
  {id:'5',runId:'run-1',type:'tool_result',createdAt:now(),content:'{"items":["成都大熊猫繁育研究基地"]}',data:{toolCallId:'a',status:'verified'}},
  {id:'6',runId:'run-1',type:'tool_result',createdAt:now(),content:'{"items":["亲子主题酒店"]}',data:{toolCallId:'b',status:'verified'}},
  {id:'7',runId:'run-1',type:'assistant',createdAt:now(),content:'<think>资源已齐，向用户确认节奏和文案。</think>\n需要你补充两点后再继续完善方案。',data:{modelTurnId:'turn-2'}},
]};
const listeners = new Set<(s:AgentSnapshot)=>void>();
const emit = () => { snapshot = {...snapshot,updatedAt:now(),run:snapshot.run?{...snapshot.run,updatedAt:now()}:null}; for(const fn of listeners) fn(structuredClone(snapshot)); return structuredClone(snapshot); };
const log=(type:any,content:string,data?:any)=>snapshot.events.push({id:crypto.randomUUID(),runId:'run-1',type,content,data,createdAt:now()});
const client = {
  agent:{get:async()=>structuredClone(snapshot),send:async(_id:string,content:string)=>{log('user',content);return emit();},
    respond:async(_id:string,response:AgentInputResponse)=>{ if(response.requestId!==snapshot.pendingInput?.id) throw Error('问题已过期'); log('user','已回答：'+JSON.stringify(response.answers));snapshot.pendingInput=undefined;snapshot.run!.status='waiting_approval';snapshot.pendingApproval={id:'approval-1',productVersion:'v1',accountKey:'测试账号',scope:['vbk.write_phase:basic','vbk.write_phase:itinerary'],summary:'两天一晚，行程节奏轻松，保留你提供的文案。请查看右侧方案后确认。',status:'pending',createdAt:now()};return emit();},
    approve:async()=>{ const approval={...snapshot.pendingApproval!,status:'approved' as const};log('approval','用户已授权',{approvalId:approval.id,approval});log('status','运行中',{status:'running'});snapshot.pendingApproval=undefined;snapshot.run!.status='running';return emit();},
    pause:async()=>{snapshot.run!.status='paused';return emit();},resume:async()=>{snapshot.run!.status='running';return emit();},abandon:async()=>{snapshot.run!.status='abandoned';return emit();}},
  events:{onAgentUpdated:(fn:any)=>{listeners.add(fn);return()=>listeners.delete(fn);}},
} as unknown as VbkApi;
(window as any).agentFixture={
  emitMessage:(text:string)=>{log('assistant',text,{modelTurnId:crypto.randomUUID()});return emit();},
  streamMessage:(text:string,done=false)=>{
    const event=snapshot.events.find(item=>item.data?.fixtureStream===true);
    if(event){event.content=text;event.data={...event.data,streaming:!done};}
    else log('assistant',text,{fixtureStream:true,streaming:!done,modelTurnId:'stream-turn'});
    return emit();
  },
  snapshot:()=>snapshot,emit,
};
const product={id:'fixture',name:'成都2天1晚亲子游',messages:[
  {id:'brief',role:'user' as const,createdAt:now(),content:JSON.stringify({type:'product_brief',destination:'成都',productFormLabel:'私家团',days:2,nights:1,userIdea:'带孩子，想轻松一点，住当地4钻。'})},
],product:{basicInfo:{meetingCity:'成都'}}} as unknown as ProductDetail;
function App(){const[input,setInput]=useState('');const[approved,setApproved]=useState(false);return <><style>{`body{margin:0;font:13px -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;color:#18181b;background:#fafafa}*{box-sizing:border-box}.fixture{display:grid;grid-template-columns:1.1fr 1fr;height:calc(100vh - 48px);gap:1px;background:#e4e4e7}.result{background:white;padding:20px;overflow:auto}header{height:48px;padding:14px 20px;background:white;border-bottom:1px solid #e4e4e7} @media(max-width:700px){.fixture{grid-template-columns:1fr;grid-template-rows:650px auto;height:auto}.result{min-height:250px}}`}</style><header>AI 对话与产品审查 · 界面验收样例 {approved&&<strong role="status">已进入 VBK 录入</strong>}</header><main className="fixture"><AgentConversation product={product} userName="演示用户" readiness={{ready:true,completion:100,issues:[]} as any} client={client} input={input} setInput={setInput} onApproved={()=>setApproved(true)}/><aside className="result" aria-label="审查结果概要" tabIndex={-1}><h3>审查结果</h3><p>结构化结果示例 · 不连接真实 VBK</p><hr/><h4>基础信息</h4><p>目的地：成都</p><p>天数：2 天 1 晚</p><h4>每日行程</h4><p>D1 · 成都大熊猫繁育研究基地</p><p>D2 · 成都城区慢游</p></aside></main></>}
createRoot(document.getElementById('root')!).render(<App/>);
