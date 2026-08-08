import { parseJson, parseAssistantMessage } from "./src/main/minimax/minimax-parsing.js";
import type OpenAI from "openai";

const sample1 = {
  toolCalls: [
    `patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"tool 拼接噪声A"],questions:[`,
    `reply:'工具参数拼接可恢复',patch:[{'op':'replace','path':'/basicInfo/subtitle','value':'太原工具参数'},questions:['是否确认接驳时间？']`,
  ],
};

console.log("===case20 parseJson tool1===", JSON.stringify(parseJson(sample1.toolCalls[0]), null, 2));
console.log("===case20 parseJson tool2===", JSON.stringify(parseJson(sample1.toolCalls[1]), null, 2));
const merged20: OpenAI.Chat.Completions.ChatCompletionMessage = {
  role: "assistant",
  content: null,
  tool_calls: sample1.toolCalls.map((arg, index) => ({
    id: `tool_${index}`,
    type: "function" as const,
    function: { name: "submit_product_update", arguments: arg },
  } as OpenAI.Chat.Completions.ChatCompletionToolMessageFunctionCall)),
} as never;
console.log("===case20 parseAssistantMessage===", JSON.stringify(parseAssistantMessage(merged20), null, 2));

const case21 = `event: message\ndata: patch:[{"op":"add","path":"/basicInfo/subtitle","value":"太原截断段测试"],questions:['是否继续补齐夜间返程？'],researchTasks:{label:'核验夜间接驳能力',type:'vbk',detail:'确认接驳时段并同步服务商'}`;
console.log("===case21 parseJson===", JSON.stringify(parseJson(case21), null, 2));

const content22 = "HTTP/1.1 200 OK\n: keep-alive\nevent: message\ndata: {\"reply\":\"抓包流重试已恢复\",\"patch\":[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"太原重试恢复\"}],\"questions\":[\"该团期是否继续压缩行程？\"]}";
const tool22 = `patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原工具重试覆盖"}],questions:['重试后可继续补齐吗？']`;
const msg22: OpenAI.Chat.Completions.ChatCompletionMessage = {
  role: "assistant",
  content: content22,
  tool_calls: [{ id: "tool_retry", type: "function" as const, function: { name: "submit_product_update", arguments: tool22 } } as OpenAI.Chat.Completions.ChatCompletionToolMessageFunctionCall],
} as never;
console.log("===case22 content parseJson===", JSON.stringify(parseJson(content22), null, 2));
console.log("===case22 parseAssistantMessage===", JSON.stringify(parseAssistantMessage(msg22), null, 2));

const caseFailure8 = JSON.stringify({
  reply: "字段类型错误导致应重试",
  patch: "[{\"op\":\"replace\",\"path\":\"/basicInfo/subtitle\",\"value\":\"失败\"}]",
  questions: ["是否继续补齐问法？"],
});
console.log("===case8 parseJson===", JSON.stringify(parseJson(caseFailure8), null, 2));
