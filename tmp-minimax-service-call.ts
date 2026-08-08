import { createServer } from "node:http";
import { MiniMaxService } from "./src/main/minimax/minimax-service.ts";

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
              arguments: `reply:'字符串补丁可恢复',patch:"[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原服务层字符串补丁\"}]",questions:["是否继续补齐夜间行程？"]`,
            },
          }],
        },
      }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const service = new MiniMaxService({ apiKey: 'test-key', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'test-model' });
  const result = await service.reply({
    message: '生成第一版',
    product: { basicInfo: { meetingCity: '太原' }, itinerary: [] },
    history: [],
  });
  console.log('result', result);
  await new Promise<void>((resolve)=>server.close(()=>resolve()));
})();
