import OpenAI from 'openai';
import { createServer } from 'node:http';
import { parseAssistantMessage } from './src/main/minimax/minimax-parsing.ts';
import { MiniMaxServiceError } from './src/main/minimax/minimax-constants.ts';

(async () => {
  const server = createServer((_request, response) => {
    const body: any = {
      choices: [{
        message: {
          content: 'tool-call 正在补齐',
          tool_calls: [{
            id: 'tool_patch_string',
            type: 'function',
            function: {
              name: 'submit_product_update',
              arguments: `reply:'字符串补丁可恢复',patch:"[{\\"op\\":\\"replace\\",\\"path\\":\\"/basicInfo/subtitle\\",\\"value\\":\\"太原服务层字符串补丁\\"}]",questions:["是否继续补齐夜间行程？"]`,
            },
          }],
        },
      }],
    };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bad');
  const client = new OpenAI({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${address.port}/v1`, timeout: 90000, maxRetries:0 });

  const product = { basicInfo: { meetingCity: '太原' }, itinerary: [] };
  const isInitialDraft = true;
  const requiresStructuredAction = false;
  const requireActionHint = true;
  const hasExistingDraft = false;
  const needsWritablePatch = true;

  for (let attempt=0; attempt<=2; attempt +=1) {
    const response = await client.chat.completions.create({
      model:'test-model',
      messages:[{ role:'system', content:'s' }, { role:'user', content:'生成第一版' }],
      max_completion_tokens:8192,
      tools:[{ type:'function', function:{name:'submit_product_update', description:'', parameters:{type:'object', properties:{}, additionalProperties:true}}}],
      tool_choice:{ type:'function', function:{name:'submit_product_update'}},
      thinking:{type:'disabled'},
      reasoning_split:true,
      service_tier:'standard',
    } as never);
    const message = response.choices[0].message;
    const parsed = parseAssistantMessage(message);
    console.log('attempt', attempt, 'raw parsed', parsed.response);
    const hasActionHint = (parsed.response.patch?.length ?? 0) >0 || (parsed.response.questions?.length ?? 0)>0 || (parsed.response.researchTasks?.length ??0)>0;
    const hasWritablePatch = !!(parsed.response.patch?.length ?? 0);
    if (requireActionHint && !parsed.isStructured) throw new MiniMaxServiceError('invalid_model_output','MiniMax 未返回可写入的产品方案，请重试。');
    if (requireActionHint && needsWritablePatch && !hasWritablePatch) throw new MiniMaxServiceError('invalid_model_output','MiniMax 未返回可写入的产品方案，请重试。');
    if (requireActionHint && parsed.isStructured && !hasActionHint) throw new MiniMaxServiceError('invalid_model_output','MiniMax 未返回可写入的产品方案，请重试。');
    console.log('success at', attempt);
    break;
  }
  await new Promise<void>((resolve)=>server.close(()=>resolve()));
})();
