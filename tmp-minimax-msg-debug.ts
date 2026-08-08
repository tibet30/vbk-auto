import { parseAssistantMessage } from './src/main/minimax/minimax-parsing.ts';

const message = {
  content: 'tool-call 正在补齐',
  tool_calls: [{
    id: 'tool_patch_string',
    type: 'function',
    function: {
      name: 'submit_product_update',
      arguments: `reply:'字符串补丁可恢复',patch:"[{\\"op\\":\\"replace\\",\\"path\\":\\"/basicInfo/subtitle\\",\\"value\\":\\"太原服务层字符串补丁\"}]",questions:["是否继续补齐夜间行程？"]`,
    },
  }],
};
const parsed = parseAssistantMessage(message as any);
console.log(parsed.response);
