import { parseJson } from './src/main/minimax/minimax-parsing.ts';
const raw = `reply:'字符串补丁可恢复',patch:"[{"op":"replace","path":"/basicInfo/subtitle","value":"太原服务层字符串补丁"}]",questions:["是否继续补齐夜间行程？"]`;
console.log('len', raw.length);
console.log(raw);
const parsed = parseJson(raw);
console.log('isStructured', parsed.isStructured);
console.log(parsed.response);
