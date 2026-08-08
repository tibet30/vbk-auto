import { createServer } from 'node:http';
import OpenAI from 'openai';

const expected = `reply:'字符串补丁可恢复',patch:\"[{\\"op\\":\\"replace\\",\\"path\\":\\"/basicInfo/subtitle\\",\\"value\\":\\"太原服务层字符串补丁\\"}]\",questions:[\"是否继续补齐夜间行程？\"]`;
console.log('expected literal length', expected.length);
console.log('expected', expected);

const server = createServer((_request, response) => {
  const current = {
    choices: [{
      message: {
        content: 'tool-call 正在补齐',
        tool_calls: [{
          id: 'tool_patch_string',
          type: 'function',
          function: {
            name: 'submit_product_update',
            arguments: expected,
          },
        }],
      },
    }],
  };
  console.log('payload arguments', current.choices[0].message.tool_calls[0].function.arguments);
  response.setHeader('content-type','application/json');
  response.end(JSON.stringify(current));
});

(async () => {
  await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const service = new OpenAI({ apiKey:'test-key', baseURL:`http://127.0.0.1:${address.port}/v1`, maxRetries:0 });
  const createResp = await service.chat.completions.create({
    model:'test-model',
    messages:[{role:'user',content:'hi'}],
    tools:[{type:'function',function:{name:'submit_product_update',description:'',parameters:{type:'object',properties:{},additionalProperties:true}}}],
    tool_choice:{type:'function', function:{name:'submit_product_update'}},
    thinking:{type:'disabled'},
    max_completion_tokens:10,
  } as never);
  console.log('client content', createResp.choices[0].message.content);
  console.log('client args', createResp.choices[0].message.tool_calls?.[0]?.function.arguments);
  await new Promise<void>((resolve)=>server.close(()=>resolve()));
})();
