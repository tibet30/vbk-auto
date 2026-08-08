const raw = `event: message
data: {"reply":"patch 为字符串可恢复","patch":"[{\\"op\\":\\"replace\\",\\"path\\":\\"/basicInfo/subtitle\\",\\"value\\":\\"太原字符串补丁\\"}]","questions":["是否继续补齐夜间安排？"]}`;
const stripInlineNoise = (raw: string) => raw
  .replace(/\/\*[^]*?\*\//g, " ")
  .replace(/(?:^|\r?\n)\s*\/\/[^\n]*$/gm, " ")
  .replace(/\n{3,}/g, "\n");
const cleaned = stripInlineNoise(raw)
  .replace(/^(?:\s*event:\s*[^\n]*)$/gim, "")
  .replace(/^\s*data:\s*/gim, "")
  .replace(/^\s*:\s*keep-alive\s*$/gim, "")
  .replace(/^\s*\[DONE\]\s*$/gim, "")
  .replace(/^\s*:\s*done\s*$/gim, "")
  .replace(/^\s*$/gm, "\n")
  .trim();
console.log('cleaned:', cleaned);
console.log('chars', [...cleaned]);
