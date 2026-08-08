import { parseJson } from './src/main/minimax/minimax-parsing.js';
const input = `event: message\ndata: {"reply":"patch 为字符串可恢复","patch":"[{\\"op\\":\\"replace\\",\\"path\\":\\"/basicInfo/subtitle\\",\\"value\\":\\"太原字符串补丁\\"}]","questions":["是否继续补齐夜间安排？"]}`;
const parsed = parseJson(input);
console.log('isStructured', parsed.isStructured);
console.log(JSON.stringify(parsed.response, null, 2));
