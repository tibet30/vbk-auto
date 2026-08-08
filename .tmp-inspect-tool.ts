import { parseJson, parseAssistantMessage } from './src/main/minimax/minimax-parsing.js';
const raw = `reply:'字符串补丁可恢复',patch:"[{\\"op\\":\\"replace\\",\\"path\\":\\"/basicInfo/subtitle\\",\\"value\\":\\"太原服务层字符串补丁\\"}]",questions:["是否继续补齐夜间行程？"]`;
console.log('parseJson raw: ', JSON.stringify(parseJson(raw), null, 2));

const fakeMsg = {
  role: 'assistant',
  content: 'tool-call 正在补齐',
  tool_calls: [{
    type: 'function',
    id: 'tool_patch_string',
    function: {
      name: 'submit_product_update',
      arguments: raw,
    },
  }],
} as any;
console.log('assistant: ', JSON.stringify(parseAssistantMessage(fakeMsg), null, 2));
