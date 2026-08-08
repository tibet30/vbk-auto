import { parseAssistantMessage } from './src/main/minimax/minimax-parsing.ts';
const case18 = {
  content: 'HTTP/1.1 200 OK\nevent: message\ndata: 仍在抓取中，请稍后',
  tool_calls: [{
    id: 'tool_noisy_mix',
    type: 'function',
    function: {
      name: 'submit_product_update',
      arguments: `event: tool-call\ndata: patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原工具优先"}],reply:'仅工具参数可写'`,
    },
  }],
};
console.log(case18);
console.log(parseAssistantMessage(case18 as any));
