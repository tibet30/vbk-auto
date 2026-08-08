import { normalizeModelPayload as nm } from './src/main/minimax/minimax-parsing.js';
const raw = `event: message
data: {"reply":"patch 为字符串可恢复","patch":"[{\\"op\\":\\"replace\\",\\"path\\":\\"/basicInfo/subtitle\\",\\"value\\":\\"太原字符串补丁\\"}]","questions":["是否继续补齐夜间安排？"]}`;
console.log(raw);
