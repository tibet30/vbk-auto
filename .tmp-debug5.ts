import { MiniMaxService } from "./src/main/minimax/minimax-service.ts";
import { createServer } from "node:http";

const scriptedResponses = [
  "先返回说明文本，等待重试。",
  `event: message
  data: {"reply":"第一条重试后恢复","patch":[{"op":"add","path":"/basicInfo/subtitle","value":"太原混合1"}],"questions":["是否继续核对机位？"]}`,
  `event: message
  data: {"reply":"第二条稳定结构","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原混合2"}],"questions":["是否继续核对酒店？"]}`,
  `event: message
  data: patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原混合3"}],questions:['是否继续核对交通？'],researchTasks:{'label':'核验机场接驳','type':'web','detail':'确认可选航班时段'}`,
  `HTTP/1.1 200 OK
event: message
data: {reply:'四号重试降噪',patch:[{"op":"add","path":"/basicInfo/subtitle","value":"太原混合4"}],researchTasks:[{"label":"核验夜间酒店","type":"vbk","detail":"确认晚间可入住"}],questions:['是否继续核对酒店协议？']}`,
  `event: message
data: {"reply":"第五条结构","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原混合5"}],"questions":["是否补齐用车说明？"],"researchTasks":[{"label":"核验接驳里程","type":"cost","detail":"对照里程与报价"}]}`,
  `: keep-alive
event: message
data: [DONE]`,
  `event: message
data: {"reply":"第七条结构","patch":[{"op":"add","path":"/basicInfo/subtitle","value":"太原混合7"}],"questions":["是否继续补齐行程？"]}`,
  `event: message
data: reply:'第八条结构',patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原混合8"}],questions:['该行程还需哪些确认？'],researchTasks:{label:'核验机票改期',type:'web','detail':'确认机票改期规则'}`,
  `event: message
data: {"reply":"第九条结构","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原混合9"}],"questions":["是否继续补充售后说明？"]}`,
  `event: message
data: {"reply":"第十条结构","patch":[{"op":"replace","path":"/basicInfo/subtitle","value":"太原混合10"}],"questions":["是否继续补齐价格提示？"]}`,
];
let requestIndex = 0;
const server = createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({
    choices: [{ message: { content: scriptedResponses[Math.min(requestIndex, scriptedResponses.length - 1)] } }],
  }));
  console.log("request", requestIndex + 1, "payload", scriptedResponses[Math.min(requestIndex, scriptedResponses.length - 1)]);
  requestIndex += 1;
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("bad addr");
const service = new MiniMaxService({ apiKey: "test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model" });
(async () => {
  let successCount = 0;
  for (let i = 0; i < 10; i += 1) {
    const result = await service.reply({
      message: i === 0 ? "生成第一版" : `继续补充 ${i}`,
      product: { basicInfo: { meetingCity: "太原" }, itinerary: [] },
      history: [],
    });
    const hasPatch = (result.patch?.length ?? 0) > 0;
    console.log("round", i + 1, "patch", hasPatch ? result.patch?.[0].value : "none", "reply", result.reply);
    if (hasPatch) successCount += 1;
  }
  console.log("successCount", successCount);
  server.close();
})();
