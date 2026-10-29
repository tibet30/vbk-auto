import { ReplayDataMissingError } from "../../src/main/infrastructure/replay-data-error.js";
import { readFileSync } from 'node:fs';
import type { CreateProductInput } from '../../src/shared/contracts.js';
import { FIXTURE_ROOT, type Json } from './corpus.js';

export interface GenerationReplay {
  version: number; provenance: string; input: CreateProductInput;
  constraints: Json; hotelRequirements: Array<{ day: number; requirement: Json }>;
  operatorInstructions: string;
  disambiguations: Array<{ desired: string; candidates: Json[]; response: Json }>;
  agentFinalResponse: { content: string };
  removals: Array<{ day: number; name: string }>;
  stageResponses: Record<string, Json>;
  /** 天标题生成工具 submit_itinerary_day_titles 的固定回复；第 n 次调用取第 n 条，缺少即失败。 */
  dayTitleResponses?: Json[];
  agentTurns: Array<{ name: string; arguments: Json }>;
}
export function loadGenerationReplay(key: string): GenerationReplay {
  const trace = JSON.parse(readFileSync(`${FIXTURE_ROOT}/${key}-generation.json`, 'utf8')) as GenerationReplay;
  if (trace.version !== 1 || !trace.input.userIdea || !trace.stageResponses.itinerary) throw new Error(`缺少需求/模型回放：${key}`);
  const encoded = JSON.stringify([trace.input, trace.constraints, trace.hotelRequirements, trace.stageResponses, trace.dayTitleResponses ?? []]);
  if (/"(?:poiId|poiName|hotelCandidates|hotelResource|resourceGroupId|imageId|pendingApproval)"\s*:/u.test(encoded)) {
    throw new Error(`生成回放不得包含已绑定资源或审批：${key}`);
  }
  const allowed = ['generate_product_module', 'resolve_itinerary_hotels', 'resolve_cover', 'resolve_vehicle_resource'];
  if (!Array.isArray(trace.agentTurns) || trace.agentTurns.some(turn => !allowed.includes(turn.name)
    || Object.keys(turn.arguments).some(key => turn.name !== 'generate_product_module' || key !== 'stage'))) {
    throw new Error(`Agent 模型回放不得预填方案或资源：${key}`);
  }
  return trace;
}
/** Only the provider response is replayed; SDK parsing, prompts and stage execution are real. */
export function installPlanningTransport(trace: GenerationReplay) {
  const previous = globalThis.fetch;
  const stages: string[] = [];
  let agentIndex = 0;
  let dayTitleCalls = 0;
  const misses: string[] = [];
  const missing = (query: string): never => { misses.push(query); throw new ReplayDataMissingError(`缺少模型响应回放：${query}`); };
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== 'https://model-replay.invalid/v1/chat/completions') return previous(input, init);
    const body = JSON.parse(input instanceof Request ? await input.text() : String(init?.body)) as Json;
    if (body.stream === true) {
      const turn = trace.agentTurns[agentIndex++];
      if (!turn && (agentIndex !== trace.agentTurns.length + 1 || !trace.agentFinalResponse?.content)) {
        return missing('agent');
      }
      const delta = turn ? { tool_calls: [{ index: 0, id: `agent-${agentIndex}`, type: 'function',
        function: { name: turn.name, arguments: JSON.stringify(turn.arguments) } }] }
        : trace.agentFinalResponse;
      const chunk = (delta: Json, finish_reason: string | null) => ({ id: `agent-${agentIndex}`,
        object: 'chat.completion.chunk', created: 0, model: 'fixed-regression',
        choices: [{ index: 0, delta, finish_reason }] });
      return new Response(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, turn ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    }
    const name = body.tool_choice?.function?.name;
    if (name === 'submit_disambiguation') {
      const request = JSON.parse(body.messages.find((m: Json) => m.role === 'user').content);
      const recording = trace.disambiguations?.find(row => row.desired === request.desired
        && JSON.stringify(row.candidates) === JSON.stringify(request.candidates));
      if (!recording) return missing(`disambiguation:${request.desired}`);
      return Response.json({ id: 'disambiguation', choices: [{ index: 0, finish_reason: 'tool_calls',
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'choice', type: 'function',
          function: { name, arguments: JSON.stringify(recording.response) } }] } }] });
    }
    if (name === 'submit_itinerary_day_titles') {
      const index = dayTitleCalls++;
      if (index >= 2) throw new Error(`模型阶段超出固定回放次数：${name}`);
      const recording = trace.dayTitleResponses?.[index];
      if (!recording) return missing(`stage:${name}`);
      return Response.json({ id: `replay-dayTitles-${index}`, object: 'chat.completion', created: 0, model: 'fixed-regression',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
          tool_calls: [{ id: `dayTitles-${index}`, type: 'function', function: { name, arguments: JSON.stringify(recording) } }] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    const stage = Object.keys(trace.stageResponses).find(s => name === `submit_${s}_module`);
    if (!stage) return missing(`stage:${name}`);
    const prompt = JSON.stringify(body.messages);
    if (!prompt.includes(trace.input.userIdea!.split('\n')[0])) throw new Error(`模型请求未包含原始需求：${stage}`);
    stages.push(stage);
    if (stages.filter(s => s === stage).length > 2) throw new Error(`模型阶段超出固定回放次数：${stage}`);
    return Response.json({ id: `replay-${stage}`, object: 'chat.completion', created: 0, model: 'fixed-regression',
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
        tool_calls: [{ id: `stage-${stage}`, type: 'function', function: { name, arguments: JSON.stringify(trace.stageResponses[stage]) } }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  };
  return { stages, misses, restore: () => { globalThis.fetch = previous; } };
}
