import OpenAI from "openai";
import { createServer } from "node:http";
import { parseAssistantMessage } from "./src/main/minimax/minimax-parsing.ts";

(async () => {
  const server = createServer((_request, response) => {
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: "tool-call 正在补齐",
          tool_calls: [{
            id: "tool_patch_string",
            type: "function",
            function: {
              name: "submit_product_update",
              arguments: `reply:'字符串补丁可恢复',patch:"[{\\"op\\":\\"replace\\",\\"path\\":\\"/basicInfo/subtitle\\",\\"value\\":\\"太原服务层字符串补丁\\"}]",questions:["是否继续补齐夜间行程？"]`,
            },
          }],
        },
      }],
    }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const client = new OpenAI({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${address.port}/v1`, timeout: 90000, maxRetries: 0 });
  const response = await client.chat.completions.create({
    model: 'test-model',
    messages: [{ role: 'user', content: '生成第一版' } as never],
    max_completion_tokens: 8192,
    tools: [{ type: 'function', function: { name: 'submit_product_update', description: '', parameters: { type: 'object', properties: {}, additionalProperties: true } } }],
    tool_choice: { type: 'function', function: { name: 'submit_product_update' } },
    thinking: { type: 'disabled' },
    reasoning_split: true,
  } as never);

  const message = response.choices[0].message;
  console.log('raw content', message.content);
  const parsed = parseAssistantMessage(message);
  console.log('parsed', parsed.isStructured, parsed.response.reply, parsed.response.patch?.[0]);
  await new Promise<void>((resolve)=>server.close(()=>resolve()));
})();
