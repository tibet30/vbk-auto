import { parseJson } from "./src/main/minimax/minimax-parsing.js";
const cases = [
  `patch:[{'op':'replace','path':'/basicInfo/subtitle','value':'太原工具参数'}]`,
  `patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"tool 拼接噪声A"}]`,
  `patch:[{'op':'replace','path':'/basicInfo/subtitle','value':'太原工具参数'},]`,
  `patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"x"],`,
  `patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"x"],questions:['q']`,
  `patch:[{"op":"replace","path":"/basicInfo/subtitle","value":"x"}],questions:['q']`,
];
for (const item of cases) {
  console.log('---');
  console.log(item.replaceAll("\n", "\\n"));
  console.log(parseJson(item));
}
