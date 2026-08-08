import { parseJson } from "./src/main/minimax/minimax-parsing.js";
const sample = `event: message
data: patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"太原混合3"}],questions:['是否继续核对交通？'],researchTasks:{'label':'核验机场接驳','type':'web','detail':'确认可选航班时段'}`;
console.log(parseJson(sample));
