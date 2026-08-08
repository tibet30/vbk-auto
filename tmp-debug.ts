import { parseJson } from './src/main/minimax/minimax-parsing.ts';
const input = `event: message
data: patch:[{"op":"add","path":"/basicInfo/subtitle","value":"太原截断段测试"},questions:['是否继续补齐夜间返程？'],researchTasks:{label:'核验夜间接驳能力',type:'vbk',detail:'确认接驳时段并同步服务商'}`;
const parsed = parseJson(input);
console.log(JSON.stringify(parsed, null, 2));
