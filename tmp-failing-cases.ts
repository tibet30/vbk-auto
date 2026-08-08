import { parseAssistantMessage } from './src/main/minimax/minimax-parsing.ts';

const case16 = {
  content: `event: message\ndata: 首次仅说明文字，稍后补齐。`,
  tool_calls: [{
    id: 'tool_retry_text',
    type: 'function',
    function: {
      name: 'submit_product_update',
      arguments: `patch:'[{"op":"replace","path":"/basicInfo/subtitle","value":"太原重试前"}]`,
    },
  }],
};
console.log('case16', parseAssistantMessage(case16 as any));

const case19 = {
  content: 'tool-call 正在补齐',
  tool_calls: [{
    id: 'tool_patch_string',
    type: 'function',
    function: {
      name: 'submit_product_update',
      arguments: `reply:'字符串补丁可恢复',patch:"[{\\"op\\":\\"replace\\",\\"path\\":\\"/basicInfo/subtitle\\",\\"value\\":\\"太原服务层字符串补丁\\"}]",questions:["是否继续补齐夜间行程？"]`,
    },
  }],
};
console.log('case19', parseAssistantMessage(case19 as any));

const case22 = `event: message\ndata: {"reply":"patch 为字符串可恢复","patch":"[{\\"op\\":\\"replace\\",\\"path\\":\\"/basicInfo/subtitle\\",\\"value\\":\\"太原字符串补丁\"}]","questions":["是否继续补齐夜间安排？"]}`;
import { parseJson } from './src/main/minimax/minimax-parsing.ts';
console.log('case22', parseJson(case22));
